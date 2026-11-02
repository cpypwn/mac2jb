import Foundation
import Vision
import AppKit

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot open \(path)\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([request])
for observation in request.results ?? [] {
    if let candidate = observation.topCandidates(1).first {
        let box = observation.boundingBox
        print(String(format: "%.3f %.3f %.3f %.3f\t%@", box.origin.x, box.origin.y, box.size.width, box.size.height, candidate.string))
    }
}
