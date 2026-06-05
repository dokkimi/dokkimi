package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"time"
)

// ArtifactType mirrors the Control Tower DTO. Only these three are accepted.
type ArtifactType string

const (
	ArtifactTypeScreenshot ArtifactType = "screenshot"
	ArtifactTypeDiff       ArtifactType = "diff"
	ArtifactTypeHTML       ArtifactType = "html"
)

// SubStepPosition identifies a sub-step within a run for artifact attribution.
type SubStepPosition struct {
	StepIndex    int
	SubStepIndex int
}

// BoundingBox is a rectangle in CSS pixels, used to mask out ignore regions
// during visual-match diffs.
type BoundingBox struct {
	Selector string  `json:"selector"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
}

// ArtifactUploader pushes binary artifacts (screenshots, diffs, failure HTML)
// to Control Tower's POST /artifacts endpoint via multipart upload.
//
// One uploader per test-agent process; instanceId is fixed at construction
// time and embedded in every request.
type ArtifactUploader struct {
	endpointURL string
	instanceId  string
	httpClient  *http.Client
}

// NewArtifactUploader constructs an uploader against Control Tower's
// /artifacts endpoint. Pass the CT base URL (without trailing /artifacts);
// the helper appends the path itself.
func NewArtifactUploader(controlTowerURL, instanceId string, timeout time.Duration) *ArtifactUploader {
	return &ArtifactUploader{
		endpointURL: controlTowerURL + "/artifacts",
		instanceId:  instanceId,
		httpClient:  &http.Client{Timeout: timeout},
	}
}

// uploadResult mirrors the JSON response from POST /artifacts.
type uploadResult struct {
	ID  string `json:"id"`
	URI string `json:"uri"`
}

// Upload posts one artifact. `name` may be empty for nameless captures
// (debug failure auto-captures); CT validates the type/name pairing.
//
// Returns the persisted URI (relative to the storage root) on success.
func (u *ArtifactUploader) Upload(
	ctx context.Context,
	artifactType ArtifactType,
	name string,
	pos SubStepPosition,
	payload []byte,
	isFailure bool,
	ignoreRegionBounds []BoundingBox,
) (string, error) {
	if u == nil {
		return "", fmt.Errorf("artifact uploader is nil (test-agent misconfigured)")
	}
	if len(payload) == 0 {
		return "", fmt.Errorf("artifact payload is empty")
	}

	body, contentType, err := u.buildMultipartBody(artifactType, name, pos, payload, isFailure, ignoreRegionBounds)
	if err != nil {
		return "", fmt.Errorf("build multipart body: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.endpointURL, body)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", contentType)

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("post artifact: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf(
			"artifact upload rejected: status=%d body=%s",
			resp.StatusCode, string(respBody),
		)
	}

	var result uploadResult
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("decode artifact response: %w (body=%s)", err, string(respBody))
	}
	return result.URI, nil
}

// buildMultipartBody assembles the multipart/form-data payload matching
// the UploadArtifactDto on the CT side. Field names must align exactly
// with class-validator's @IsString/@IsInt expectations.
func (u *ArtifactUploader) buildMultipartBody(
	artifactType ArtifactType,
	name string,
	pos SubStepPosition,
	payload []byte,
	isFailure bool,
	ignoreRegionBounds []BoundingBox,
) (*bytes.Buffer, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	fields := []struct {
		key, value string
	}{
		{"instanceId", u.instanceId},
		{"stepIndex", strconv.Itoa(pos.StepIndex)},
		{"subStepIndex", strconv.Itoa(pos.SubStepIndex)},
		{"type", string(artifactType)},
	}
	for _, f := range fields {
		if err := w.WriteField(f.key, f.value); err != nil {
			return nil, "", err
		}
	}
	if name != "" {
		if err := w.WriteField("name", name); err != nil {
			return nil, "", err
		}
	}
	if isFailure {
		if err := w.WriteField("isFailure", "true"); err != nil {
			return nil, "", err
		}
	}
	if len(ignoreRegionBounds) > 0 {
		boundsJSON, err := json.Marshal(ignoreRegionBounds)
		if err != nil {
			return nil, "", fmt.Errorf("marshal ignoreRegionBounds: %w", err)
		}
		if err := w.WriteField("ignoreRegionBounds", string(boundsJSON)); err != nil {
			return nil, "", err
		}
	}

	filename := "payload"
	if artifactType == ArtifactTypeHTML {
		filename = "payload.html"
	} else {
		filename = "payload.png"
	}
	part, err := w.CreateFormFile("payload", filename)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(payload); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return &buf, w.FormDataContentType(), nil
}
