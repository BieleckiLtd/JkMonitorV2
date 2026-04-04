# Design System: Tactical Command Framework

## 1. Overview & Creative North Star: "The Precision Command Deck"
This design system is a departure from the "friendly SaaS" aesthetic. It is a high-performance interface designed for technical mastery. The Creative North Star, **"The Precision Command Deck,"** envisions the UI not as a webpage, but as a specialized piece of hardware—an illuminated glass console in a darkened room.

We break the "template" look through **intentional architectural density**. Unlike consumer apps that prioritize whitespace to reduce cognitive load, this system prioritizes *information density* and *instrumentation*. We use hard 0px corners to evoke industrial precision, asymmetrical layouts to mirror complex data flows, and a "HUD" (Heads-Up Display) mentality where every pixel serves a functional purpose.

---

## 2. Colors: Obsidian & Ionized Accents
The palette is rooted in the "Deep Obsidian" void, using light not as a decoration, but as a functional signal.

### The Palette
*   **Background (Deep Obsidian):** `#0A0B10` — The absolute foundation.
*   **Surfaces (Slate Grey):** `#1E2028` — Used for primary interaction zones.
*   **Primary (Cyber Lime):** `#C5FF41` — High-energy signal for "Active," "Online," or "Primary Action."
*   **Secondary (Pulse Blue):** `#419FFF` — Cooling signal for "Processing," "Info," or "Sub-system."
*   **Neutral/Outline:** `#8D937B` at 10-20% opacity.

### The "No-Line" Rule
Traditional 1px solid borders are strictly prohibited for sectioning. Structural separation is achieved through **Background Color Shifts**. Use `surface-container-low` against the `background` to define a zone. If a visual break is required, use a 1px height difference in vertical rhythm or a subtle shift in the grain texture density.

### Surface Hierarchy & Nesting
Treat the UI as a physical stack of technical glass:
1.  **Level 0 (Background):** `#0A0B10` — The base vacuum.
2.  **Level 1 (Sub-panels):** `surface-container-low` (`#1A1B21`) — For peripheral data.
3.  **Level 2 (Active Deck):** `surface-container` (`#1E1F25`) — The primary workspace.
4.  **Level 3 (Command Overlays):** `surface-bright` (`#38393F`) — For high-priority modals or alerts.

### The "Glass & Gradient" Rule
Floating utility widgets should utilize a **Glassmorphic** effect: `surface` color at 60% opacity with a `20px` backdrop-blur. Apply a subtle linear gradient (Top-Left to Bottom-Right) from `primary` to `primary-container` at 5% opacity to simulate a light-catch on the glass edge.

---

## 3. Typography: The Industrial Editorial
The typographic contrast is the primary driver of the "High-End" feel. We pair the geometric tension of **Space Grotesk** with the utilitarian rigor of **JetBrains Mono**.

*   **Display & Headlines (Space Grotesk):** Use for system status and high-level navigation. The high-contrast letterforms feel engineered. 
    *   *Rule:* Always use `letter-spacing: -0.02em` for headlines to create a tight, "locked-in" appearance.
*   **Data & Terminal (JetBrains Mono):** This is the workhorse. All telemetry, IP addresses, and logs must use this font.
    *   *Rule:* Use `label-sm` for captions to mimic the technical specifications found on hardware components.

---

## 4. Elevation & Depth: Tonal Layering
We do not use shadows to create "float"; we use them to create **"glow"** or **"recession."**

*   **The Layering Principle:** Depth is achieved by nesting. A `surface-container-highest` widget sitting inside a `surface-container-lowest` bay creates a natural "docked" appearance without any shadows.
*   **Micro-Shadows:** For floating command palettes, use an **Ambient Glow**: 
    *   `box-shadow: 0 10px 40px -10px rgba(197, 255, 65, 0.08);` (Using a tinted Primary color).
*   **The Ghost Border:** Where containment is critical, use a 1px border with `white` at `10%` opacity. This simulates the beveled edge of a glass screen.
*   **Signature Texture:** Large surfaces (`background` and `surface`) must have a subtle `2%` film grain texture overlay. This breaks the "flat" digital feel and gives the UI a tactile, analog hardware quality.

---

## 5. Components: Custom Utility Widgets

### Buttons (Command Triggers)
*   **Primary:** Solid `Cyber Lime` (`#C5FF41`) with `on-primary` (`#253500`) text. 0px border radius.
*   **Secondary:** `Ghost Border` (10% white) with `JetBrains Mono` text. On hover, the border opacity increases to 40%.
*   **Tertiary:** Text-only with a leading `+` or `_` character to evoke terminal commands.

### High-Precision Data Viz (SVG)
Avoid library defaults. Charts should be:
*   **Stroke-based:** No filled areas unless using a 10% opacity Pulse Blue.
*   **Data Points:** Use 2px x 2px squares instead of circles.
*   **Grids:** Use dotted lines (`stroke-dasharray: 2 4`) in `outline-variant`.

### Input Fields (Parameters)
*   **Styling:** Underline-only (2px) using `surface-variant`. On focus, the underline transforms into `Cyber Lime`.
*   **Label:** Always `label-sm` in `JetBrains Mono`, placed above the input in all-caps.

### Tactical Cards
*   **Constraint:** No dividers. Use `24px` or `32px` gaps to separate content groups. 
*   **Feature:** Every card should have a "Coordinate" in the top right (e.g., `REF_01-A`) in `label-sm` to reinforce the "Command Deck" aesthetic.

---

## 6. Do's and Don'ts

### Do
*   **Use Asymmetry:** Place a heavy data widget on the left and a slim terminal feed on the right.
*   **Embrace Monospace:** Use JetBrains Mono for anything that isn't a headline.
*   **Use Micro-Animations:** Transitions should be instant (100ms) or "mechanical" (stepped easing) rather than bouncy or soft.

### Don't
*   **No Rounded Corners:** `0px` is the absolute rule. Any radius breaks the "Tactical" precision.
*   **No Standard Blue:** Never use default SaaS blues. Use `Pulse Blue` sparingly for functional data only.
*   **No Soft Shadows:** Avoid large, blurry black shadows that suggest a "paper" metaphor. We are working with "light and glass."
*   **No Generic Icons:** Use custom, thin-stroke (1.5px) SVG icons with square terminators.