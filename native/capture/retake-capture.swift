// retake-capture: records ONE window of a Mac app with ScreenCaptureKit, at
// the display's backing scale, and nothing else on screen: not the desktop,
// not a window that covers it, not a notification.
//
//   retake-capture check
//     {"screenRecording":true,"macos":"26.5.1"}
//   retake-capture record <windowID> <out.mp4> [fps]
//     {"event":"started","at":<epoch ms of the first frame written>,"width":1920,"height":1080,"scale":2}
//     ... records until its stdin closes (or SIGTERM/SIGINT), then
//     {"event":"stopped","file":"<out.mp4>"}
//   Any failure: {"event":"error","error":"…"} and exit 1.
//
// Stopping on stdin closing is deliberate: if Retake dies, the pipe closes
// and the recording stops. A recorder that outlives its take is a privacy bug.
import AppKit
import AVFoundation
import Foundation
import ScreenCaptureKit

// A command-line tool must connect to the window server before it captures,
// or ScreenCaptureKit asserts (CGS_REQUIRE_INIT).
_ = NSApplication.shared
_ = CGMainDisplayID()

func emit(_ obj: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) {
    print(s); fflush(stdout)
  }
}
func fail(_ m: String) -> Never { emit(["event": "error", "error": m]); exit(1) }

let args = CommandLine.arguments
let v = ProcessInfo.processInfo.operatingSystemVersion
let macos = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"

if args.count >= 2 && args[1] == "check" {
  emit(["screenRecording": CGPreflightScreenCaptureAccess(), "macos": macos])
  exit(0)
}
guard args.count >= 4, args[1] == "record", let wid = CGWindowID(args[2]) else {
  FileHandle.standardError.write("usage: retake-capture check | record <windowID> <out.mp4> [fps]\n".data(using: .utf8)!)
  exit(2)
}
guard #available(macOS 15.0, *) else { fail("recording a window needs macOS 15 or newer (this is \(macos))") }
let out = URL(fileURLWithPath: args[3])
let fps = args.count >= 5 ? max(10, min(60, Int32(args[4]) ?? 30)) : 30
try? FileManager.default.removeItem(at: out)

@available(macOS 15.0, *)
final class Recorder: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
  var stream: SCStream?
  var size: (Int, Int, Double) = (0, 0, 1)
  var finished = false
  func recordingOutputDidStartRecording(_ r: SCRecordingOutput) {
    emit(["event": "started", "at": Int(Date().timeIntervalSince1970 * 1000), "width": size.0, "height": size.1, "scale": size.2])
  }
  func recordingOutput(_ r: SCRecordingOutput, didFailWithError e: Error) { fail("recording: \(e.localizedDescription)") }
  func recordingOutputDidFinishRecording(_ r: SCRecordingOutput) {
    finished = true
    emit(["event": "stopped", "file": out.path]); exit(0)
  }
  func stream(_ s: SCStream, didStopWithError e: Error) { fail("the window stopped being capturable: \(e.localizedDescription)") }
  func stop() {
    guard let s = stream else { exit(0) }
    s.stopCapture { _ in
      // The file is finalised a moment after the stream stops; if the
      // finish callback never comes, say so instead of hanging.
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if !self.finished { fail("the recording did not finish writing") } }
    }
  }
}

if #available(macOS 15.0, *) {
  let rec = Recorder()
  for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { rec.stop() }
    src.resume()
    _ = Unmanaged.passRetained(src)
  }
  // Stop when stdin closes: the parent is gone, or it is done.
  DispatchQueue.global().async {
    while let _ = readLine(strippingNewline: true) {}
    DispatchQueue.main.async { rec.stop() }
  }
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let win = content.windows.first(where: { $0.windowID == wid }) else { fail("no window \(wid) (it may have closed)") }
      let filter = SCContentFilter(desktopIndependentWindow: win)
      let scale = Double(filter.pointPixelScale)
      let cfg = SCStreamConfiguration()
      cfg.width = Int(win.frame.width * scale)
      cfg.height = Int(win.frame.height * scale)
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
      cfg.showsCursor = false
      cfg.capturesAudio = false
      rec.size = (cfg.width, cfg.height, scale)
      let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
      let oc = SCRecordingOutputConfiguration()
      oc.outputURL = out
      oc.outputFileType = .mp4
      oc.videoCodecType = .h264
      try stream.addRecordingOutput(SCRecordingOutput(configuration: oc, delegate: rec))
      rec.stream = stream
      try await stream.startCapture()
    } catch {
      let m = error.localizedDescription
      fail(m.range(of: "declined|TCC|not authorized", options: [.regularExpression, .caseInsensitive]) != nil ? "Screen Recording is not allowed for this app (\(m)). Allow it in System Settings → Privacy & Security → Screen & System Audio Recording." : m)
    }
  }
  RunLoop.main.run()
}
