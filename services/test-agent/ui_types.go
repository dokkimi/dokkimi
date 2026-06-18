package main

import (
	"encoding/json"
	"fmt"
)

// UISubStepKind identifies the kind of UI sub-step. The wire format is a JSON
// object with EXACTLY ONE of these as a top-level key; the value under that key
// carries the sub-step payload.
type UISubStepKind string

const (
	UISubVisit      UISubStepKind = "visit"
	UISubClick      UISubStepKind = "click"
	UISubType       UISubStepKind = "type"
	UISubWaitFor    UISubStepKind = "waitFor"
	UISubExtract    UISubStepKind = "extract"
	UISubScreenshot UISubStepKind = "screenshot"
	UISubScroll     UISubStepKind = "scroll"
	UISubSelect     UISubStepKind = "select"
	UISubHover      UISubStepKind = "hover"
	UISubKey        UISubStepKind = "key"
	UISubUpload     UISubStepKind = "upload"
	UISubDrag       UISubStepKind = "drag"
	UISubViewport   UISubStepKind = "viewport"
)

var validUISubStepKinds = map[UISubStepKind]struct{}{
	UISubVisit:      {},
	UISubClick:      {},
	UISubType:       {},
	UISubWaitFor:    {},
	UISubExtract:    {},
	UISubScreenshot: {},
	UISubScroll:     {},
	UISubSelect:     {},
	UISubHover:      {},
	UISubKey:        {},
	UISubUpload:     {},
	UISubDrag:       {},
	UISubViewport:   {},
}

// UIAction is the payload under a StepAction of type "ui".
//
// Wire form:
//
//	{
//	  "type":   "ui",
//	  "target": "frontend-svc",
//	  "steps":  [ ...UISubStep... ]
//	}
type UIAction struct {
	Target string      `json:"target"`
	Steps  []UISubStep `json:"steps"`
}

// UISubStep is a single UI action step. The JSON shape is a discriminated union
// where the discriminator is the object key itself — see UISubStepKind. Only
// one field is populated per instance; which one is indicated by Kind.
//
// A sub-step can also be a "group" — an entry with a loop modifier (forEach,
// for, repeat) and a nested `steps` array instead of a regular sub-step key.
// When IsGroup is true, the loop modifier + Group.Steps are populated and the
// regular kind fields are ignored.
type UISubStep struct {
	Kind UISubStepKind

	// Exactly one of the following is populated based on Kind.
	Visit      string            // Kind == UISubVisit
	Click      string            // Kind == UISubClick
	Type       *UITypeStep       // Kind == UISubType
	WaitFor    *UIWaitForStep    // Kind == UISubWaitFor
	Extract    UIExtractMap      // Kind == UISubExtract
	Screenshot *UIScreenshotStep // Kind == UISubScreenshot
	Scroll     *UIScrollStep     // Kind == UISubScroll
	Select     *UISelectStep     // Kind == UISubSelect
	Hover      string            // Kind == UISubHover
	Key        *UIKeyStep        // Kind == UISubKey
	Upload     *UIUploadStep     // Kind == UISubUpload
	Drag       *UIDragStep       // Kind == UISubDrag
	Viewport   *UIViewportStep   // Kind == UISubViewport

	// Optional per-sub-step timeout in milliseconds. When > 0, overrides the
	// executor's defaultUISubStepTimeout for this sub-step only. Wire form is
	// a sibling of the kind discriminator: { click: "...", timeoutMs: 5000 }.
	TimeoutMs int

	// Sub-step group fields (loop modifier + nested steps).
	IsGroup bool
	ForEach *ForEachLoop `json:"forEach,omitempty"`
	For     *ForLoop     `json:"for,omitempty"`
	Repeat  *RepeatLoop  `json:"repeat,omitempty"`
	Steps   []UISubStep  `json:"steps,omitempty"` // nested sub-steps in a group
}

// UIScrollStep is the payload for a "scroll" sub-step. Two shapes are
// accepted on the wire — a bare selector string scrolls that element into
// view; an object form `{ x, y }` scrolls the page to absolute pixel coords.
// `Selector` and (X, Y) are mutually exclusive after parsing.
type UIScrollStep struct {
	Selector string `json:"selector,omitempty"`
	X        *int   `json:"x,omitempty"`
	Y        *int   `json:"y,omitempty"`
}

// UISelectStep is the payload for a "select" sub-step: set the value of a
// native `<select>` and dispatch a `change` event so React/Vue/etc. listeners
// react. Use plain `click` sub-steps for custom (non-`<select>`) dropdowns.
type UISelectStep struct {
	Selector string `json:"selector"`
	Value    string `json:"value"`
}

// UIKeyStep is the payload for a "key" sub-step: send a single keyboard key
// (Enter, Escape, Tab, ArrowDown, etc.). String form `key: "Enter"` sends to
// the currently focused element; object form `key: { selector, key }` waits
// for the selector, focuses it, then sends the key.
type UIKeyStep struct {
	Selector string `json:"selector,omitempty"`
	Key      string `json:"key"`
}

// UIUploadStep is the payload for an "upload" sub-step: attach files to a
// `<input type="file">`. `Files` are paths to files that already exist
// inside the test-agent container (e.g. baked into a custom image, or
// mounted via a volume); v1 does not bundle files from the test
// definition itself.
type UIUploadStep struct {
	Selector string   `json:"selector"`
	Files    []string `json:"files"`
}

// UIViewportStep is the payload for a "viewport" sub-step: resize the browser
// viewport to the given dimensions. Use this before `visit` to test responsive
// layouts or ensure elements are positioned consistently across environments.
type UIViewportStep struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// UIDragStep is the payload for a "drag" sub-step: synthesize a mouse
// drag from one element to another. The driver reads each element's
// bounding box, presses the mouse at the source center, moves through
// an intermediate point (so HTML5 dragstart fires), and releases at the
// target center. Works for HTML5 native drag and most JS drag libraries
// (react-dnd, dnd-kit) that listen on real mouse events; pure
// dispatchEvent-only libraries are out of scope.
type UIDragStep struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// UITypeStep is the payload for a "type" sub-step: type `text` into `selector`.
type UITypeStep struct {
	Selector string `json:"selector"`
	Text     string `json:"text"`
}

// UIScreenshotStep is the payload for a "screenshot" sub-step. Wire form is
// either a bare string (the name; full-page capture, no diff) or an object
// with optional region-scoping and an optional `match` block that turns the
// capture into a visual-regression check against
// `.dokkimi/<project>/baselines/<name>.png`. test-agent only captures and
// uploads; CT runs the post-run diff (see UI_TEST_ARTIFACT_PIPELINE.md).
type UIScreenshotStep struct {
	Name     string             `json:"name"`
	Selector string             `json:"selector,omitempty"`
	Match    *UIScreenshotMatch `json:"match,omitempty"`
}

// UIScreenshotMatch is the optional baseline-diff configuration on a
// screenshot sub-step. Presence (even empty) signals "compare against the
// baseline keyed by Name"; absence means pure evidence capture, no diff.
//
// Wire form is polymorphic: `match: true` for "diff with defaults" and
// `match: { threshold?, ignoreRegions? }` for "diff with overrides".
// Marshal emits `true` when no overrides are set so round-trip stays clean.
type UIScreenshotMatch struct {
	Threshold     *float64 `json:"threshold,omitempty"`     // 0-1, default 0.01 (1% of pixels may differ)
	IgnoreRegions []string `json:"ignoreRegions,omitempty"` // selectors masked out before diffing
}

// MarshalJSON emits the boolean short-form when no overrides are set,
// matching the wire form most users will write.
func (m UIScreenshotMatch) MarshalJSON() ([]byte, error) {
	if m.Threshold == nil && len(m.IgnoreRegions) == 0 {
		return []byte("true"), nil
	}
	type alias UIScreenshotMatch // sidestep recursion
	return json.Marshal(alias(m))
}

// UIWaitForStep is the payload for a "waitFor" sub-step when supplied as an
// object. A string-form waitFor is equivalent to { Selector: <string> }.
type UIWaitForStep struct {
	Selector string `json:"selector"`
	Text     string `json:"text,omitempty"` // optional: wait until element text equals this
}

// UIExtractMap is the payload for an "extract" sub-step: variable name → source.
type UIExtractMap map[string]UIExtractSource

// UIExtractFrom enumerates the valid extraction source kinds.
type UIExtractFrom string

const (
	UIExtractFromText           UIExtractFrom = "text"
	UIExtractFromAttribute      UIExtractFrom = "attribute"
	UIExtractFromValue          UIExtractFrom = "value"
	UIExtractFromURL            UIExtractFrom = "url"
	UIExtractFromCookie         UIExtractFrom = "cookie"
	UIExtractFromLocalStorage   UIExtractFrom = "localStorage"
	UIExtractFromSessionStorage UIExtractFrom = "sessionStorage"
	UIExtractFromCount          UIExtractFrom = "count"
	UIExtractFromExists         UIExtractFrom = "exists"
)

// UIExtractURLPart enumerates the parts of a URL that can be extracted.
type UIExtractURLPart string

const (
	UIURLPartFull     UIExtractURLPart = "full"
	UIURLPartPathname UIExtractURLPart = "pathname"
	UIURLPartSearch   UIExtractURLPart = "search"
	UIURLPartHash     UIExtractURLPart = "hash"
	UIURLPartHost     UIExtractURLPart = "host"
)

// UIExtractSource is a single extract source spec. Required fields depend on
// From; see validate-ui-action.ts in @dokkimi/definition-validator for the
// canonical rules. Optional `Pattern` + `Group` apply a regex to the extracted
// raw value.
type UIExtractSource struct {
	From     UIExtractFrom    `json:"from"`
	Selector string           `json:"selector,omitempty"`
	Name     string           `json:"name,omitempty"` // attribute or cookie
	Key      string           `json:"key,omitempty"`  // localStorage / sessionStorage
	Part     UIExtractURLPart `json:"part,omitempty"` // url
	Pattern  string           `json:"pattern,omitempty"`
	Group    *int             `json:"group,omitempty"`
}

// ---------------------------------------------------------------------------
// JSON marshaling for the single-key-discriminator shape
// ---------------------------------------------------------------------------

// UnmarshalJSON accepts the wire shape:
//
//	{ "visit":      "/path" }
//	{ "click":      "[data-testid='x']" }
//	{ "type":       { "selector": ..., "text": ... } }
//	{ "waitFor":    "selector" }  OR  { "waitFor": { "selector": ..., "text": ... } }
//	{ "extract":    { "<var>": UIExtractSource, ... } }
//	{ "screenshot": "name" }
//
// Exactly one recognized key must be present.
func (s *UISubStep) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("ui sub-step: %w", err)
	}

	// Check if this is a sub-step group (has a loop modifier key + steps).
	_, hasForEach := raw["forEach"]
	_, hasFor := raw["for"]
	_, hasRepeat := raw["repeat"]
	_, hasSteps := raw["steps"]
	if (hasForEach || hasFor || hasRepeat) && hasSteps {
		s.IsGroup = true
		if hasForEach {
			fe := &ForEachLoop{}
			if err := json.Unmarshal(raw["forEach"], fe); err != nil {
				return fmt.Errorf("ui sub-step group forEach: %w", err)
			}
			s.ForEach = fe
		}
		if hasFor {
			fl := &ForLoop{}
			if err := json.Unmarshal(raw["for"], fl); err != nil {
				return fmt.Errorf("ui sub-step group for: %w", err)
			}
			s.For = fl
		}
		if hasRepeat {
			rl := &RepeatLoop{}
			if err := json.Unmarshal(raw["repeat"], rl); err != nil {
				return fmt.Errorf("ui sub-step group repeat: %w", err)
			}
			s.Repeat = rl
		}
		if err := json.Unmarshal(raw["steps"], &s.Steps); err != nil {
			return fmt.Errorf("ui sub-step group steps: %w", err)
		}
		return nil
	}

	var foundKind UISubStepKind
	var foundValue json.RawMessage
	foundCount := 0
	for k, v := range raw {
		if k == "timeoutMs" {
			if err := json.Unmarshal(v, &s.TimeoutMs); err != nil {
				return fmt.Errorf("ui sub-step timeoutMs: %w", err)
			}
			continue
		}
		kind := UISubStepKind(k)
		if _, ok := validUISubStepKinds[kind]; !ok {
			continue // ignore unknown keys; validator surfaces them upstream
		}
		foundKind = kind
		foundValue = v
		foundCount++
	}
	if foundCount == 0 {
		return fmt.Errorf("ui sub-step: no recognized kind key present")
	}
	if foundCount > 1 {
		return fmt.Errorf("ui sub-step: multiple kind keys present; expected exactly one")
	}

	s.Kind = foundKind
	switch foundKind {
	case UISubVisit:
		if err := json.Unmarshal(foundValue, &s.Visit); err != nil {
			return fmt.Errorf("ui sub-step visit: %w", err)
		}
	case UISubClick:
		if err := json.Unmarshal(foundValue, &s.Click); err != nil {
			return fmt.Errorf("ui sub-step click: %w", err)
		}
	case UISubType:
		t := &UITypeStep{}
		if err := json.Unmarshal(foundValue, t); err != nil {
			return fmt.Errorf("ui sub-step type: %w", err)
		}
		s.Type = t
	case UISubWaitFor:
		w, err := unmarshalWaitFor(foundValue)
		if err != nil {
			return err
		}
		s.WaitFor = w
	case UISubExtract:
		m := UIExtractMap{}
		if err := json.Unmarshal(foundValue, &m); err != nil {
			return fmt.Errorf("ui sub-step extract: %w", err)
		}
		s.Extract = m
	case UISubScreenshot:
		ss, err := unmarshalScreenshot(foundValue)
		if err != nil {
			return err
		}
		s.Screenshot = ss
	case UISubScroll:
		sc, err := unmarshalScroll(foundValue)
		if err != nil {
			return err
		}
		s.Scroll = sc
	case UISubSelect:
		sl := &UISelectStep{}
		if err := json.Unmarshal(foundValue, sl); err != nil {
			return fmt.Errorf("ui sub-step select: %w", err)
		}
		s.Select = sl
	case UISubHover:
		if err := json.Unmarshal(foundValue, &s.Hover); err != nil {
			return fmt.Errorf("ui sub-step hover: %w", err)
		}
	case UISubKey:
		k, err := unmarshalKey(foundValue)
		if err != nil {
			return err
		}
		s.Key = k
	case UISubUpload:
		u := &UIUploadStep{}
		if err := json.Unmarshal(foundValue, u); err != nil {
			return fmt.Errorf("ui sub-step upload: %w", err)
		}
		s.Upload = u
	case UISubDrag:
		d := &UIDragStep{}
		if err := json.Unmarshal(foundValue, d); err != nil {
			return fmt.Errorf("ui sub-step drag: %w", err)
		}
		s.Drag = d
	case UISubViewport:
		v := &UIViewportStep{}
		if err := json.Unmarshal(foundValue, v); err != nil {
			return fmt.Errorf("ui sub-step viewport: %w", err)
		}
		s.Viewport = v
	}
	return nil
}

// MarshalJSON emits the wire shape corresponding to Kind.
func (s UISubStep) MarshalJSON() ([]byte, error) {
	if s.IsGroup {
		obj := map[string]interface{}{}
		if s.ForEach != nil {
			obj["forEach"] = s.ForEach
		}
		if s.For != nil {
			obj["for"] = s.For
		}
		if s.Repeat != nil {
			obj["repeat"] = s.Repeat
		}
		obj["steps"] = s.Steps
		return json.Marshal(obj)
	}
	obj := map[string]interface{}{}
	switch s.Kind {
	case UISubVisit:
		obj[string(s.Kind)] = s.Visit
	case UISubClick:
		obj[string(s.Kind)] = s.Click
	case UISubType:
		obj[string(s.Kind)] = s.Type
	case UISubWaitFor:
		if s.WaitFor != nil && s.WaitFor.Text == "" {
			obj[string(s.Kind)] = s.WaitFor.Selector
		} else {
			obj[string(s.Kind)] = s.WaitFor
		}
	case UISubExtract:
		obj[string(s.Kind)] = s.Extract
	case UISubScreenshot:
		// String form when only Name is set; object form when selector or
		// match is configured (region-scoped capture or visual-regression check).
		if s.Screenshot != nil && s.Screenshot.Selector == "" && s.Screenshot.Match == nil {
			obj[string(s.Kind)] = s.Screenshot.Name
		} else {
			obj[string(s.Kind)] = s.Screenshot
		}
	case UISubScroll:
		// String form when only Selector is set; object form otherwise.
		if s.Scroll != nil && s.Scroll.X == nil && s.Scroll.Y == nil {
			obj[string(s.Kind)] = s.Scroll.Selector
		} else {
			obj[string(s.Kind)] = s.Scroll
		}
	case UISubSelect:
		obj[string(s.Kind)] = s.Select
	case UISubHover:
		obj[string(s.Kind)] = s.Hover
	case UISubKey:
		// String form when only Key is set; object form otherwise.
		if s.Key != nil && s.Key.Selector == "" {
			obj[string(s.Kind)] = s.Key.Key
		} else {
			obj[string(s.Kind)] = s.Key
		}
	case UISubUpload:
		obj[string(s.Kind)] = s.Upload
	case UISubDrag:
		obj[string(s.Kind)] = s.Drag
	case UISubViewport:
		obj[string(s.Kind)] = s.Viewport
	default:
		return nil, fmt.Errorf("ui sub-step: unknown kind %q", s.Kind)
	}
	if s.TimeoutMs > 0 {
		obj["timeoutMs"] = s.TimeoutMs
	}
	return json.Marshal(obj)
}

// unmarshalWaitFor accepts either a selector string or an object form.
func unmarshalWaitFor(raw json.RawMessage) (*UIWaitForStep, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return &UIWaitForStep{Selector: asString}, nil
	}
	w := &UIWaitForStep{}
	if err := json.Unmarshal(raw, w); err != nil {
		return nil, fmt.Errorf("ui sub-step waitFor: %w", err)
	}
	return w, nil
}

// unmarshalScroll accepts either a selector string (`scroll: "..."`) — scroll
// the matching element into view — or an object form `{ selector?, x?, y? }`
// — scroll to absolute page coords (or the element to those local coords).
func unmarshalScroll(raw json.RawMessage) (*UIScrollStep, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return &UIScrollStep{Selector: asString}, nil
	}
	sc := &UIScrollStep{}
	if err := json.Unmarshal(raw, sc); err != nil {
		return nil, fmt.Errorf("ui sub-step scroll: %w", err)
	}
	return sc, nil
}

// unmarshalScreenshot accepts either a name string (`screenshot: "..."`) —
// full-page capture, no diff — or an object form
// `{ name, selector?, match? }` — region-scoped capture and/or
// post-run baseline diff. The `match` field is itself polymorphic:
// `match: true` opts into the diff with default options;
// `match: { threshold?, ignoreRegions? }` opts in with overrides;
// `match: false` or absent means no diff.
func unmarshalScreenshot(raw json.RawMessage) (*UIScreenshotStep, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return &UIScreenshotStep{Name: asString}, nil
	}
	// Decode the struct fields directly, capturing match as raw bytes so we
	// can dispatch on its shape (bool vs object).
	var alias struct {
		Name     string          `json:"name"`
		Selector string          `json:"selector"`
		Match    json.RawMessage `json:"match,omitempty"`
	}
	if err := json.Unmarshal(raw, &alias); err != nil {
		return nil, fmt.Errorf("ui sub-step screenshot: %w", err)
	}
	ss := &UIScreenshotStep{Name: alias.Name, Selector: alias.Selector}
	if len(alias.Match) > 0 {
		m, err := unmarshalScreenshotMatch(alias.Match)
		if err != nil {
			return nil, err
		}
		ss.Match = m
	}
	return ss, nil
}

// unmarshalScreenshotMatch accepts either a boolean (`true` = diff with
// default options, `false` = no diff) or an object with options. Returns
// nil for the false / absent cases so the caller's Match pointer stays nil.
func unmarshalScreenshotMatch(raw json.RawMessage) (*UIScreenshotMatch, error) {
	var asBool bool
	if err := json.Unmarshal(raw, &asBool); err == nil {
		if !asBool {
			return nil, nil
		}
		return &UIScreenshotMatch{}, nil
	}
	m := &UIScreenshotMatch{}
	if err := json.Unmarshal(raw, m); err != nil {
		return nil, fmt.Errorf("ui sub-step screenshot.match: %w", err)
	}
	return m, nil
}

// unmarshalKey accepts either a key-name string (`key: "Enter"`) — send the
// key to the currently focused element — or an object form `{ selector, key }`
// — focus the selector first, then send.
func unmarshalKey(raw json.RawMessage) (*UIKeyStep, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return &UIKeyStep{Key: asString}, nil
	}
	k := &UIKeyStep{}
	if err := json.Unmarshal(raw, k); err != nil {
		return nil, fmt.Errorf("ui sub-step key: %w", err)
	}
	return k, nil
}
