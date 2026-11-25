/** `%%` / `##` cell markers, MATLAB-style. `%%%` or `###` lines are ordinary comments. */
export const SECTION_MARKER = /^\s*(%%|##)(?![%#])/;

export interface Section {
  /** First line (0-based, inclusive). The marker line itself when there is one. */
  start: number;
  /** Last line (0-based, inclusive). */
  end: number;
  /** Text after the marker, or '' for the implicit section before the first marker. */
  title: string;
  /** 1-based position of the section within the file. */
  index: number;
}

/** Find the section containing `line` in a document given as an array of lines. */
export function sectionAt(lines: readonly string[], line: number): Section {
  const isMarker = (i: number) => SECTION_MARKER.test(lines[i] ?? '');
  const cur = Math.max(0, Math.min(line, lines.length - 1));

  let start = 0;
  let markersUpToStart = 0;
  for (let i = 0; i <= cur; i++) {
    if (isMarker(i)) { start = i; markersUpToStart++; }
  }
  let end = lines.length - 1;
  for (let i = cur + 1; i < lines.length; i++) {
    if (isMarker(i)) { end = i - 1; break; }
  }
  const hasLeadingSection = !isMarker(0);
  const index = markersUpToStart + (hasLeadingSection ? 1 : 0) || 1;
  const title = isMarker(start) ? lines[start].replace(SECTION_MARKER, '').trim() : '';
  return { start, end, title, index };
}
