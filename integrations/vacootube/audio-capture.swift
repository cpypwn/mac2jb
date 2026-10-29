import AudioToolbox
import AVFAudio
import CoreAudio
import Foundation

enum TapFailure: Error, CustomStringConvertible {
    case operation(String, OSStatus)

    var description: String {
        switch self {
        case .operation(let name, let status): return "\(name) failed (OSStatus \(status))"
        }
    }
}

final class AudioTap {
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var deviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private let writer = DispatchQueue(label: "vacootube.audio.writer")
    private var rate: Double = 48_000
    private var phase = 0.0

    func start(processes: [AudioObjectID]) throws {
        let description = CATapDescription()
        description.name = "VacooTube audio"
        description.uuid = UUID()
        description.processes = processes
        description.isExclusive = false
        description.isPrivate = true
        description.isMixdown = true
        description.isMono = false
        description.muteBehavior = .unmuted
        var newTap: AudioObjectID = kAudioObjectUnknown
        var status = AudioHardwareCreateProcessTap(description, &newTap)
        guard status == noErr else { throw TapFailure.operation("create process tap", status) }
        tapID = newTap

        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.stride)
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &format)
        guard status == noErr else { throw TapFailure.operation("read tap format", status) }
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mBitsPerChannel == 32,
              format.mChannelsPerFrame == 2,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mSampleRate > 0 else {
            throw NSError(domain: "VacooTubeAudio", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported CoreAudio tap format"])
        }
        rate = format.mSampleRate

        let output = try Self.defaultOutput()
        let outputUID = try Self.stringProperty(output, kAudioDevicePropertyDeviceUID)
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "VacooTube capture",
            kAudioAggregateDeviceUIDKey as String: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [[kAudioSubDeviceUIDKey as String: outputUID]],
            kAudioAggregateDeviceTapListKey as String: [[
                kAudioSubTapDriftCompensationKey as String: true,
                kAudioSubTapUIDKey as String: description.uuid.uuidString
            ]]
        ]
        var aggregateID: AudioObjectID = kAudioObjectUnknown
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { throw TapFailure.operation("create aggregate device", status) }
        deviceID = aggregateID

        var ioID: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcID(deviceID, { _, _, input, _, _, _, context in
            guard let context else { return noErr }
            Unmanaged<AudioTap>.fromOpaque(context).takeUnretainedValue().receive(input)
            return noErr
        }, Unmanaged.passUnretained(self).toOpaque(), &ioID)
        guard status == noErr, let ioID else { throw TapFailure.operation("create audio callback", status) }
        ioProcID = ioID
        status = AudioDeviceStart(deviceID, ioID)
        guard status == noErr else { throw TapFailure.operation("start audio capture", status) }
    }

    func stop() {
        if let ioProcID {
            AudioDeviceStop(deviceID, ioProcID)
            AudioDeviceDestroyIOProcID(deviceID, ioProcID)
            self.ioProcID = nil
        }
        if deviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(deviceID)
            deviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }

    private func receive(_ input: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard !buffers.isEmpty else { return }
        let frameCount: Int
        if buffers.count == 1 {
            frameCount = Int(buffers[0].mDataByteSize) / 8
        } else {
            frameCount = min(Int(buffers[0].mDataByteSize), Int(buffers[1].mDataByteSize)) / 4
        }
        guard frameCount > 0 else { return }
        guard let firstData = buffers[0].mData else { return }
        let first = firstData.assumingMemoryBound(to: Float32.self)
        let second = buffers.count > 1 ? buffers[1].mData?.assumingMemoryBound(to: Float32.self) : nil
        if buffers.count > 1 && second == nil { return }
        let step = rate / 48_000
        var position = phase
        var samples = [Int16]()
        samples.reserveCapacity(Int(Double(frameCount) / step + 2) * 2)
        while position < Double(frameCount) {
            let index = min(Int(position), frameCount - 1)
            let next = min(index + 1, frameCount - 1)
            let fraction = Float32(position - Double(index))
            let left = second == nil ? first[2 * index] : first[index]
            let right = second == nil ? first[2 * index + 1] : second![index]
            let nextLeft = second == nil ? first[2 * next] : first[next]
            let nextRight = second == nil ? first[2 * next + 1] : second![next]
            samples.append(Self.pcm(left + (nextLeft - left) * fraction))
            samples.append(Self.pcm(right + (nextRight - right) * fraction))
            position += step
        }
        phase = position - Double(frameCount)
        let bytes = samples.withUnsafeBytes { Data($0) }
        writer.async {
            bytes.withUnsafeBytes { raw in
                guard let base = raw.baseAddress else { return }
                var sent = 0
                while sent < raw.count {
                    let count = Darwin.write(STDOUT_FILENO, base.advanced(by: sent), raw.count - sent)
                    if count <= 0 { return }
                    sent += count
                }
            }
        }
    }

    func selfTestPCM() {
        var input: [Float32] = [0, 0.5, -0.5, 1]
        input.withUnsafeMutableBufferPointer { samples in
            var buffers = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(mNumberChannels: 2,
                                      mDataByteSize: UInt32(samples.count * MemoryLayout<Float32>.size),
                                      mData: samples.baseAddress)
            )
            withUnsafePointer(to: &buffers) { receive($0) }
        }
        writer.sync {}
    }

    private static func pcm(_ value: Float32) -> Int16 {
        Int16((max(-1, min(1, value)) * 32767).rounded())
    }

    private static func defaultOutput() throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device: AudioObjectID = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr else { throw TapFailure.operation("read output device", status) }
        return device
    }

    private static func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.stride)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
        }
        guard status == noErr else { throw TapFailure.operation("read output device UID", status) }
        return value as String
    }
}

func descendants(of root: Int32) throws -> Set<Int32> {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-axo", "pid=,ppid="]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    try process.run()
    let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw TapFailure.operation("enumerate processes", OSStatus(process.terminationStatus)) }
    let lines = String(decoding: bytes, as: UTF8.self).split(separator: "\n")
    var parent: [Int32: Int32] = [:]
    for line in lines {
        let values = line.split(whereSeparator: \.isWhitespace)
        if values.count == 2, let pid = Int32(values[0]), let ppid = Int32(values[1]) { parent[pid] = ppid }
    }
    var result: Set<Int32> = [root]
    var changed = true
    while changed {
        changed = false
        for (pid, ppid) in parent where result.contains(ppid) && !result.contains(pid) {
            result.insert(pid)
            changed = true
        }
    }
    return result
}

func audioProcesses(in pids: Set<Int32>) throws -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { throw TapFailure.operation("read audio process list", status) }
    var objects = [AudioObjectID](repeating: kAudioObjectUnknown, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    status = objects.withUnsafeMutableBytes { bytes in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, bytes.baseAddress!)
    }
    guard status == noErr else { throw TapFailure.operation("read audio process list", status) }
    var result: [AudioObjectID] = []
    for object in objects {
        var pidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid: Int32 = 0
        var pidSize = UInt32(MemoryLayout<Int32>.size)
        if AudioObjectGetPropertyData(object, &pidAddress, 0, nil, &pidSize, &pid) == noErr && pids.contains(pid) {
            result.append(object)
        }
    }
    return result.sorted()
}

@main
struct Main {
    static func main() throws {
        if CommandLine.arguments == [CommandLine.arguments[0], "--self-test-pcm"] {
            AudioTap().selfTestPCM()
            return
        }
        guard CommandLine.arguments.count == 2,
              let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
            fputs("usage: vacootube-audio PID\n", stderr)
            exit(2)
        }
        var tap: AudioTap?
        var selected: [AudioObjectID] = []
        while true {
            do {
                let next = try audioProcesses(in: descendants(of: pid))
                if next != selected {
                    tap?.stop()
                    tap = nil
                    selected = next
                    if !next.isEmpty {
                        let capture = AudioTap()
                        do {
                            try capture.start(processes: next)
                            tap = capture
                        } catch {
                            capture.stop()
                            throw error
                        }
                    }
                }
            } catch {
                fputs("vacootube audio capture failed: \(error)\n", stderr)
                tap?.stop()
                exit(1)
            }
            Thread.sleep(forTimeInterval: 1)
        }
    }
}
