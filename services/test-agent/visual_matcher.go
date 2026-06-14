package main

import (
	"bytes"
	"image"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	pixmatch "github.com/dknight/go-pixmatch"
)

const (
	defaultVisualThreshold = 0.01
	pixelSensitivity       = 0.1
)

type VisualMatcher struct {
	baselinesPath string
}

func NewVisualMatcher(baselinesPath string) *VisualMatcher {
	if baselinesPath == "" {
		return nil
	}
	return &VisualMatcher{baselinesPath: baselinesPath}
}

type VisualMatchResult struct {
	Verdict string
	DiffPng []byte
}

func (vm *VisualMatcher) Match(name string, capturePng []byte, match *UIScreenshotMatch, bounds []BoundingBox) VisualMatchResult {
	if match == nil {
		return VisualMatchResult{}
	}
	if vm == nil {
		log.Printf("visualMatch %s: no baselines directory mounted", name)
		return VisualMatchResult{Verdict: "no-baseline"}
	}

	baselinePath := filepath.Join(vm.baselinesPath, name+".png")
	baselineBytes, err := os.ReadFile(baselinePath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("visualMatch %s: no baseline found", name)
			return VisualMatchResult{Verdict: "no-baseline"}
		}
		log.Printf("visualMatch %s: baseline read error: %v", name, err)
		return VisualMatchResult{Verdict: "no-baseline"}
	}

	baselineImg, err := png.Decode(bytes.NewReader(baselineBytes))
	if err != nil {
		log.Printf("visualMatch %s: baseline decode error: %v", name, err)
		return VisualMatchResult{Verdict: "fail", DiffPng: capturePng}
	}
	captureImg, err := png.Decode(bytes.NewReader(capturePng))
	if err != nil {
		log.Printf("visualMatch %s: capture decode error: %v", name, err)
		return VisualMatchResult{Verdict: "fail", DiffPng: capturePng}
	}

	bBounds := baselineImg.Bounds()
	cBounds := captureImg.Bounds()
	if bBounds.Dx() != cBounds.Dx() || bBounds.Dy() != cBounds.Dy() {
		log.Printf("visualMatch %s: size mismatch baseline=%dx%d capture=%dx%d",
			name, bBounds.Dx(), bBounds.Dy(), cBounds.Dx(), cBounds.Dy())
		return VisualMatchResult{Verdict: "fail", DiffPng: capturePng}
	}

	if len(bounds) > 0 {
		baselineImg = maskRegions(baselineImg, bounds)
		captureImg = maskRegions(captureImg, bounds)
	}

	baselinePM := toPixmatchImage(baselineImg)
	capturePM := toPixmatchImage(captureImg)

	var diffBuf bytes.Buffer
	opts := pixmatch.NewOptions().
		SetThreshold(pixelSensitivity).
		SetOutput(&diffBuf)

	numDiff, err := baselinePM.Compare(capturePM, opts)
	if err != nil {
		log.Printf("visualMatch %s: compare error: %v", name, err)
		return VisualMatchResult{Verdict: "fail", DiffPng: capturePng}
	}

	totalPixels := bBounds.Dx() * bBounds.Dy()
	fraction := 0.0
	if totalPixels > 0 {
		fraction = float64(numDiff) / float64(totalPixels)
	}

	userThreshold := defaultVisualThreshold
	if match.Threshold != nil {
		userThreshold = *match.Threshold
	}

	if fraction <= userThreshold {
		log.Printf("visualMatch %s: pass (diff=%.4f%% threshold=%.4f%%)", name, fraction*100, userThreshold*100)
		return VisualMatchResult{Verdict: "pass"}
	}

	log.Printf("visualMatch %s: fail (diff=%.4f%% threshold=%.4f%%)", name, fraction*100, userThreshold*100)

	diffPng := encodePng(&diffBuf, bBounds.Dx(), bBounds.Dy())
	if diffPng == nil {
		diffPng = capturePng
	}
	return VisualMatchResult{Verdict: "fail", DiffPng: diffPng}
}

func toPixmatchImage(img image.Image) *pixmatch.Image {
	b := img.Bounds()
	pm := pixmatch.NewImage(b.Dx(), b.Dy(), "png")
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bv, a := img.At(x, y).RGBA()
			idx := ((y-b.Min.Y)*b.Dx() + (x - b.Min.X)) * pm.BPC
			if idx+3 < len(pm.PixData) {
				pm.PixData[idx] = r
				pm.PixData[idx+1] = g
				pm.PixData[idx+2] = bv
				pm.PixData[idx+3] = a
			}
		}
	}
	return pm
}

func maskRegions(img image.Image, bounds []BoundingBox) image.Image {
	b := img.Bounds()
	masked := image.NewRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			masked.Set(x, y, img.At(x, y))
		}
	}
	for _, bb := range bounds {
		x0 := int(math.Max(0, math.Floor(bb.X)))
		y0 := int(math.Max(0, math.Floor(bb.Y)))
		x1 := int(math.Min(float64(b.Dx()), math.Ceil(bb.X+bb.Width)))
		y1 := int(math.Min(float64(b.Dy()), math.Ceil(bb.Y+bb.Height)))
		black := image.Black.At(0, 0)
		for y := y0; y < y1; y++ {
			for x := x0; x < x1; x++ {
				masked.Set(x+b.Min.X, y+b.Min.Y, black)
			}
		}
	}
	return masked
}

func encodePng(buf *bytes.Buffer, w, h int) []byte {
	if buf.Len() == 0 {
		return nil
	}
	// go-pixmatch writes raw RGBA bytes to the output writer; wrap in a PNG.
	data := buf.Bytes()
	expectedLen := w * h * 4
	if len(data) < expectedLen {
		return nil
	}
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(out.Pix, data[:expectedLen])
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, out); err != nil {
		return nil
	}
	return pngBuf.Bytes()
}
