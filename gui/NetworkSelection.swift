import Foundation
import Darwin

struct NetworkAddress: Identifiable, Hashable {
    let address: String
    let interface: String
    var id: String { "\(interface):\(address)" }
    var label: String { "\(address) · \(interface)" }
}

enum NetworkSelection {
    struct Refresh: Equatable {
        let addresses: [NetworkAddress]
        let selected: String
        let changed: Bool
    }

    static func refresh(selected: String, previous: [NetworkAddress], available: [NetworkAddress], lockedInterface: String? = nil) -> Refresh {
        let valid = available.filter { isIPv4($0.address) }
        if let lockedInterface, !lockedInterface.isEmpty {
            let eligible = valid.filter { $0.interface == lockedInterface }
            let replacement = eligible.first { $0.address == selected }?.address ?? eligible.first?.address ?? ""
            return Refresh(addresses: valid, selected: replacement, changed: replacement != selected)
        }
        if valid.contains(where: { $0.address == selected }) {
            return Refresh(addresses: valid, selected: selected, changed: false)
        }
        let interface = previous.first { $0.address == selected }?.interface
        let next = valid.first { $0.interface == interface } ?? valid.first
        let replacement = next?.address ?? ""
        return Refresh(addresses: valid, selected: replacement, changed: replacement != selected)
    }

    static func safePreflightFailure(retrySafe: Bool, hostStarting: Bool, hostReady: Bool,
                                     hasHIDWorker: Bool, hasHIDEvidence: Bool, postRunActive: Bool) -> Bool {
        retrySafe && hostStarting && !hostReady && !hasHIDWorker && !hasHIDEvidence && !postRunActive
    }

    static func isIPv4(_ address: String) -> Bool {
        var value = in_addr()
        return address.withCString { inet_pton(AF_INET, $0, &value) } == 1
    }

    static func localAddresses() -> [NetworkAddress] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0, let initial = first else { return [] }
        defer { freeifaddrs(first) }
        var values: [NetworkAddress] = []
        var item: UnsafeMutablePointer<ifaddrs>? = initial
        while let current = item {
            defer { item = current.pointee.ifa_next }
            let info = current.pointee
            guard let address = info.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  (info.ifa_flags & UInt32(IFF_UP)) != 0, (info.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let string = String(cString: buffer)
                if !string.hasPrefix("169.254.") { values.append(NetworkAddress(address: string, interface: String(cString: info.ifa_name))) }
            }
        }
        return values.sorted { a, b in
            let physicalA = a.interface.hasPrefix("en"), physicalB = b.interface.hasPrefix("en")
            if physicalA != physicalB { return physicalA }
            return a.label < b.label
        }
    }
}
