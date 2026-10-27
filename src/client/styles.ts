/**
 * One injected stylesheet for the highlight buckets and the chip.
 *
 * `::highlight()` accepts only a small property subset (color, background-color,
 * text-decoration, text-shadow, …) — no gradients, borders or box-shadow — so the
 * weak `low` bucket is a pale background plus a dotted underline instead of the
 * left colour bar from the product spec. `low` is deliberately much fainter than
 * `medium`; `critical` is a solid wash.
 */

/** Attribute that marks the injected stylesheet for removal on dispose. */
export const STYLE_ATTRIBUTE = 'data-jev-highlight'

/** Chip class prefix. */
export const CHIP_CLASS = 'jev-highlight-chip'

export const HIGHLIGHT_CSS = `
::highlight(jev-critical){
  background-color: rgba(255, 138, 0, 0.62);
  color: #1a1206;
}
::highlight(jev-medium){
  background-color: rgba(255, 190, 26, 0.42);
}
::highlight(jev-low){
  background-color: rgba(255, 214, 102, 0.18);
  text-decoration: underline dotted rgba(196, 132, 0, 0.9);
  text-underline-offset: 2px;
}
@media (prefers-color-scheme: dark){
  ::highlight(jev-critical){
    background-color: rgba(255, 145, 0, 0.52);
    color: #fff7ed;
  }
  ::highlight(jev-medium){
    background-color: rgba(255, 190, 26, 0.3);
  }
  ::highlight(jev-low){
    background-color: rgba(255, 214, 102, 0.12);
    text-decoration: underline dotted rgba(255, 200, 90, 0.9);
    text-underline-offset: 2px;
  }
}
.${CHIP_CLASS}{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
  box-sizing: border-box;
}
.${CHIP_CLASS}[data-enabled="false"]{
  opacity: 0.55;
}
.${CHIP_CLASS} .jev-chip-label{
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.${CHIP_CLASS} .jev-chip-count{
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
}
.${CHIP_CLASS} .jev-chip-dot{
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="critical"]{
  background: #ff8a00;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="medium"]{
  background: #e6aa18;
}
.${CHIP_CLASS} .jev-chip-dot[data-level="low"]{
  background: #b99b5e;
  opacity: 0.5;
}
.${CHIP_CLASS} .jev-chip-toggle{
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 14%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.${CHIP_CLASS} .jev-chip-toggle:hover{
  background: color-mix(in srgb, currentColor 24%, transparent);
}
.${CHIP_CLASS} .jev-chip-toggle[data-on="true"]{
  color: #0f7b46;
}
.${CHIP_CLASS} .jev-chip-status{
  font-size: 11px;
  opacity: 0.8;
}
`
