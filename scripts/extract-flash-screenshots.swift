import AppKit
import Foundation
import Vision

struct OCRLine {
  let text: String
  let confidence: Float
  let box: CGRect
}

struct MatchRecord: Encodable {
  let invaderId: String
  let sourcePath: String
  let cropPath: String
  let cropRect: CropRect
  let ocrLine: String
  let ocrConfidence: Float
  let allOcrLines: [String]
}

struct CropRect: Encodable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

struct IndexRecord: Encodable {
  let scannedAt: String
  let inputDir: String
  let scannedFiles: Int
  let matchedFiles: Int
  let records: [MatchRecord]
}

let root = URL(fileURLWithPath: "/Users/jakob/Projects/si-reference-library")
let arguments = Array(CommandLine.arguments.dropFirst())
let inputDir = arguments.first.map(URL.init(fileURLWithPath:)) ?? URL(fileURLWithPath: "/Users/jakob/Downloads/screenshots")
let outputDir = arguments.dropFirst().first.map(URL.init(fileURLWithPath:)) ?? root.appendingPathComponent("data/flash-screenshots", isDirectory: true)
let manualMatchesURL = root.appendingPathComponent("data/flash-screenshots/manual-matches.json")

let fileManager = FileManager.default
try fileManager.createDirectory(at: outputDir, withIntermediateDirectories: true)

let imageFiles = try fileManager.contentsOfDirectory(at: inputDir, includingPropertiesForKeys: nil)
  .filter { url in
    let ext = url.pathExtension.lowercased()
    return ["png", "jpg", "jpeg"].contains(ext)
  }
  .sorted { $0.lastPathComponent < $1.lastPathComponent }
let manualMatches = loadManualMatches(from: manualMatchesURL)

var matches: [MatchRecord] = []

for fileURL in imageFiles {
  guard let image = NSImage(contentsOf: fileURL),
        let cgImage = image.cgImageForCurrent else {
    continue
  }

  let primaryLines = try recognizeText(in: cgImage)
  let secondaryLines = try recognizeSecondaryText(in: cgImage)
  let ocrLines = dedupeOCRLines(primaryLines + secondaryLines)
  let manualInvaderId = manualMatches[fileURL.lastPathComponent]
  guard let idMatch = try findInvaderId(in: ocrLines, image: cgImage, manualInvaderId: manualInvaderId) else {
    continue
  }

  let crop = cropReferenceImage(from: cgImage)
  let invaderDir = outputDir.appendingPathComponent("by-id/\(idMatch.invaderId)", isDirectory: true)
  try fileManager.createDirectory(at: invaderDir, withIntermediateDirectories: true)
  let cropFilename = fileURL.deletingPathExtension().lastPathComponent + "-crop.png"
  let cropURL = invaderDir.appendingPathComponent(cropFilename)
  try writePNG(crop, to: cropURL)

  matches.append(
    MatchRecord(
      invaderId: idMatch.invaderId,
      sourcePath: fileURL.path,
      cropPath: cropURL.path,
      cropRect: idMatch.cropRect(for: cgImage),
      ocrLine: idMatch.line.text,
      ocrConfidence: idMatch.line.confidence,
      allOcrLines: ocrLines.map(\.text)
    )
  )
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
let index = IndexRecord(
  scannedAt: ISO8601DateFormatter().string(from: Date()),
  inputDir: inputDir.path,
  scannedFiles: imageFiles.count,
  matchedFiles: matches.count,
  records: matches
)
let indexURL = outputDir.appendingPathComponent("index.json")
try encoder.encode(index).write(to: indexURL)

print("Scanned \(imageFiles.count) files")
print("Matched \(matches.count) Flash Invaders screenshots")
print("Wrote index to \(indexURL.path)")

private extension NSImage {
  var cgImageForCurrent: CGImage? {
    guard let tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffRepresentation) else {
      return nil
    }
    return bitmap.cgImage
  }
}

func recognizeText(in cgImage: CGImage) throws -> [OCRLine] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = ["en-US"]
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])

  return (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else {
      return nil
    }
    return OCRLine(text: candidate.string, confidence: candidate.confidence, box: observation.boundingBox)
  }
}

func recognizeSecondaryText(in cgImage: CGImage) throws -> [OCRLine] {
  let width = cgImage.width
  let height = cgImage.height
  let rect = CGRect(
    x: Int(Double(width) * 0.18),
    y: Int(Double(height) * 0.55),
    width: Int(Double(width) * 0.64),
    height: Int(Double(height) * 0.24)
  )

  guard let cropped = cgImage.cropping(to: rect) else {
    return []
  }

  return try recognizeText(in: cropped)
}

struct IDMatch {
  let invaderId: String
  let line: OCRLine

  func cropRect(for image: CGImage) -> CropRect {
    return computeCropRect(for: image)
  }
}

func findInvaderId(in lines: [OCRLine], image: CGImage, manualInvaderId: String?) throws -> IDMatch? {
  let sortedLines = lines.sorted(by: { $0.box.origin.y > $1.box.origin.y })

  if let manualInvaderId {
    let fallbackLine = sortedLines.first ?? OCRLine(text: "MANUAL:\(manualInvaderId)", confidence: 1, box: .zero)
    return IDMatch(invaderId: manualInvaderId, line: fallbackLine)
  }

  for line in sortedLines {
    let normalized = line.text
      .uppercased()
      .replacingOccurrences(of: " ", with: "")
    let candidateSource: String
    if let range = normalized.range(of: "YOUFOUND") {
      candidateSource = String(normalized[range.upperBound...])
    } else if let range = normalized.range(of: "YOUFOUNO") {
      candidateSource = String(normalized[range.upperBound...])
    } else if let range = normalized.range(of: "YOUF0UND") {
      candidateSource = String(normalized[range.upperBound...])
    } else {
      continue
    }

    guard var invaderId = extractInvaderId(from: candidateSource) else {
      continue
    }

    if isSuspiciousInvaderId(invaderId), let refined = try refineInvaderId(from: line, in: image) {
      invaderId = refined
    }
    return IDMatch(invaderId: invaderId, line: line)
  }

  let combined = sortedLines
    .map { $0.text.uppercased().replacingOccurrences(of: " ", with: "") }
    .joined()
  let markerCandidates = ["YOUFOUND", "YOUFOUNO", "YOUF0UND", "YOUFOUND!"]
  for marker in markerCandidates {
    if let range = combined.range(of: marker) {
      let candidateSource = String(combined[range.upperBound...])
      if let invaderId = extractInvaderId(from: candidateSource) {
        let fallbackLine = sortedLines.first ?? OCRLine(text: combined, confidence: 0, box: .zero)
        return IDMatch(invaderId: invaderId, line: fallbackLine)
      }
    }
  }

  return nil
}

func cropReferenceImage(from image: CGImage) -> CGImage {
  let rectInfo = computeCropRect(for: image)
  let rect = CGRect(x: rectInfo.x, y: rectInfo.y, width: rectInfo.width, height: rectInfo.height)
  guard let coarseCrop = image.cropping(to: rect) else {
    return image
  }

  let refinedRect = trimBlackBorder(in: coarseCrop)
  guard let refinedCrop = coarseCrop.cropping(to: refinedRect) else {
    return coarseCrop
  }
  return refinedCrop
}

func computeCropRect(for image: CGImage) -> CropRect {
  let width = image.width
  let height = image.height
  let cropWidth = Int(Double(width) * 0.84)
  let cropHeight = Int(Double(height) * 0.34)
  let cropX = Int(Double(width) * 0.08)
  let cropY = Int(Double(height) * 0.10)
  return CropRect(x: cropX, y: cropY, width: cropWidth, height: cropHeight)
}

func isSuspiciousInvaderId(_ id: String) -> Bool {
  let parts = id.split(separator: "_", maxSplits: 1).map(String.init)
  guard parts.count == 2 else { return false }
  let suffix = parts[1]
  return suffix.count == 1 || suffix == "0"
}

func refineInvaderId(from line: OCRLine, in image: CGImage) throws -> String? {
  let width = CGFloat(image.width)
  let height = CGFloat(image.height)
  let box = line.box
  let paddingX = box.width * 0.15
  let paddingY = box.height * 0.45

  let x = max(0, Int((box.minX - paddingX) * width))
  let y = max(0, Int((box.minY - paddingY) * height))
  let w = min(Int((box.width + paddingX * 2) * width), image.width - x)
  let h = min(Int((box.height + paddingY * 2) * height), image.height - y)
  guard w > 0, h > 0 else { return nil }

  let rect = CGRect(x: x, y: y, width: w, height: h)
  guard let cropped = image.cropping(to: rect) else {
    return nil
  }

  let refinedLines = try recognizeText(in: cropped)

  for refined in refinedLines {
    let normalized = refined.text.uppercased().replacingOccurrences(of: " ", with: "")
    guard let candidate = extractInvaderId(from: normalized) else {
      continue
    }
    if !isSuspiciousInvaderId(candidate) || candidate.count > 4 {
      return candidate
    }
  }

  return nil
}

func extractInvaderId(from text: String) -> String? {
  let pattern = try! NSRegularExpression(pattern: #"([A-Z]{1,6})_?([0-9OSIL]{1,5})"#)
  let range = NSRange(location: 0, length: text.utf16.count)
  guard let match = pattern.firstMatch(in: text, options: [], range: range),
        let prefixRange = Range(match.range(at: 1), in: text),
        let suffixRange = Range(match.range(at: 2), in: text) else {
    return nil
  }

  let prefix = String(text[prefixRange])
  let suffix = String(text[suffixRange])
  let normalizedSuffix = suffix
    .replacingOccurrences(of: "O", with: "0")
    .replacingOccurrences(of: "S", with: "5")
    .replacingOccurrences(of: "I", with: "1")
    .replacingOccurrences(of: "L", with: "1")
  return "\(prefix)_\(normalizedSuffix)"
}

func dedupeOCRLines(_ lines: [OCRLine]) -> [OCRLine] {
  var seen = Set<String>()
  var deduped: [OCRLine] = []
  for line in lines {
    let key = line.text.uppercased().replacingOccurrences(of: " ", with: "")
    if seen.contains(key) {
      continue
    }
    seen.insert(key)
    deduped.append(line)
  }
  return deduped
}

func loadManualMatches(from url: URL) -> [String: String] {
  guard let data = try? Data(contentsOf: url),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
    return [:]
  }
  return json
}

func trimBlackBorder(in image: CGImage) -> CGRect {
  guard let dataProvider = image.dataProvider,
        let data = dataProvider.data,
        let bytes = CFDataGetBytePtr(data) else {
    return CGRect(x: 0, y: 0, width: image.width, height: image.height)
  }

  let width = image.width
  let height = image.height
  let bytesPerRow = image.bytesPerRow
  let bitsPerPixel = image.bitsPerPixel
  let bytesPerPixel = max(bitsPerPixel / 8, 4)

  var rowCounts = Array(repeating: 0, count: height)
  var columnCounts = Array(repeating: 0, count: width)

  for y in 0..<height {
    let row = bytes + y * bytesPerRow
    for x in 0..<width {
      let pixel = row + x * bytesPerPixel
      let red = Int(pixel[0])
      let green = Int(pixel[1])
      let blue = Int(pixel[2])
      if isContentPixel(red: red, green: green, blue: blue) {
        rowCounts[y] += 1
        columnCounts[x] += 1
      }
    }
  }

  let rowThreshold = max(24, Int(Double(width) * 0.10))
  guard let rowBand = longestRun(in: rowCounts, threshold: rowThreshold) else {
    return CGRect(x: 0, y: 0, width: width, height: height)
  }

  var croppedColumnCounts = Array(repeating: 0, count: width)
  for y in rowBand.lowerBound...rowBand.upperBound {
    let row = bytes + y * bytesPerRow
    for x in 0..<width {
      let pixel = row + x * bytesPerPixel
      let red = Int(pixel[0])
      let green = Int(pixel[1])
      let blue = Int(pixel[2])
      if isContentPixel(red: red, green: green, blue: blue) {
        croppedColumnCounts[x] += 1
      }
    }
  }

  let rowBandLength = rowBand.upperBound - rowBand.lowerBound + 1
  let columnThreshold = max(18, Int(Double(rowBandLength) * 0.10))
  guard let columnBand = longestRun(in: croppedColumnCounts, threshold: columnThreshold) else {
    return CGRect(x: 0, y: rowBand.lowerBound, width: width, height: rowBandLength)
  }

  let padding = max(6, Int(Double(min(width, height)) * 0.01))
  let originX = max(0, columnBand.lowerBound - padding)
  let originY = max(0, rowBand.lowerBound - padding)
  let trimmedWidth = min(width - originX, columnBand.count + padding * 2)
  let trimmedHeight = min(height - originY, rowBandLength + padding * 2)

  return CGRect(x: originX, y: originY, width: trimmedWidth, height: trimmedHeight)
}

func isContentPixel(red: Int, green: Int, blue: Int) -> Bool {
  let maxChannel = max(red, max(green, blue))
  let sum = red + green + blue
  return maxChannel > 24 && sum > 48
}

func longestRun(in counts: [Int], threshold: Int) -> ClosedRange<Int>? {
  var bestStart = -1
  var bestEnd = -1
  var currentStart: Int?

  for (index, count) in counts.enumerated() {
    if count >= threshold {
      if currentStart == nil {
        currentStart = index
      }
    } else if let start = currentStart {
      let end = index - 1
      if (end - start) > (bestEnd - bestStart) {
        bestStart = start
        bestEnd = end
      }
      currentStart = nil
    }
  }

  if let start = currentStart {
    let end = counts.count - 1
    if (end - start) > (bestEnd - bestStart) {
      bestStart = start
      bestEnd = end
    }
  }

  guard bestStart >= 0, bestEnd >= bestStart else {
    return nil
  }
  return bestStart...bestEnd
}

func writePNG(_ image: CGImage, to url: URL) throws {
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "extract-flash-screenshots", code: 1)
  }
  try data.write(to: url)
}
