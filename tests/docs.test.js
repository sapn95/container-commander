// The documentation, tested.
//
// Two failures in the catalogue were made worse by prose that had drifted from
// the code, so the claims this repository makes about itself are checked the
// same way its behaviour is. A README nobody re-reads after writing is a README
// that will eventually be wrong in a way that costs somebody a day.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');
const README = read('README.md');
const ARCH = read('docs/architecture.md');
const PROTO = read('docs/protocol.md');
const CATALOG = read('docs/failure-catalog.md');
const ALL = [README, ARCH, PROTO, CATALOG].join('\n');

const mermaidIn = (text) => [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('the Mermaid blocks GitHub has to render', () => {
  const blocks = mermaidIn(ALL);

  it('exist at all — the ladder and the protocol are the two things prose is bad at', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('has no semicolon inside a sequence diagram', () => {
    // A semicolon SEPARATES STATEMENTS there, so one inside a note ends the
    // note and the rest is a parse error. GitHub then renders "Unable to
    // render rich display" and the whole diagram becomes a wall of text.
    for (const b of blocks.filter((x) => x.includes('sequenceDiagram'))) {
      expect(b).not.toContain(';');
    }
  });

  it('quotes every flowchart label that carries punctuation', () => {
    // Unquoted (), :, and the rest end a node early.
    for (const b of blocks.filter((x) => x.includes('flowchart'))) {
      for (const label of b.match(/\[[^\]]*\]|\{[^}]*\}/g) ?? []) {
        const inner = label.slice(1, -1);
        if (/[(),:;]/.test(inner)) expect(inner.startsWith('"')).toBe(true);
      }
    }
  });

  it('never sets a fill without setting a colour with it', () => {
    // A fill alone leaves the label to whichever theme the reader is in, and
    // the pair has to be readable in both. Light-mode-only styling is how a
    // diagram ends up as grey-on-near-white for half its audience.
    for (const b of blocks) {
      for (const style of b.match(/style \w+ [^\n]*/g) ?? []) {
        if (style.includes('fill:')) expect(style).toMatch(/color:/);
      }
    }
  });
});

describe('what the documentation promises', () => {
  it('states the one idea, because everything else follows from it', () => {
    expect(README).toMatch(/property of a \*{0,2}flow\*{0,2}, not of a/i);
  });

  it('names every rung of the ladder in the architecture', () => {
    for (const rung of ['GATE 0', 'RUNG 1', 'RUNG 2', 'RUNG 3', 'RUNG 4', 'RUNG 5', 'RUNG 6']) {
      expect(ARCH).toContain(rung);
    }
  });

  it('admits the two things this design cannot do', () => {
    // Both were adversarial findings, and both are the kind of limit somebody
    // discovers as "a bug" unless it is written down as a decision.
    // Managed storage is boot-time, and a POST body cannot survive a reopen.
    expect(ARCH).toMatch(/once per extension start/i);
    expect(ARCH).toMatch(/POST body cannot survive/i);
  });

  it('keeps the protocol frozen at four messages, in writing', () => {
    for (const m of ['cc:claim', 'cc:release', 'cc:opened', 'cc:ping']) {
      expect(PROTO).toContain(m);
    }
    expect(PROTO).toMatch(/fifth is a design discussion/i);
  });
});

describe('the failure catalogue', () => {
  it('carries every failure the regression suite claims to cover', () => {
    const regressions = read('tests/regressions.catalog.test.js');
    for (const f of ['F1', 'F2', 'F4', 'F6']) {
      expect(CATALOG).toContain(`## ${f} `);
      expect(regressions).toContain(f);
    }
  });

  it('says what each one cost, not just what it was', () => {
    // A catalogue of symptoms teaches nothing. The consequence is the part
    // that stops somebody re-introducing it for a good-sounding reason.
    expect(CATALOG).toMatch(/block cookies/i);
    expect(CATALOG).toMatch(/before first paint/i);
  });
});

describe('the ADRs', () => {
  const dir = 'docs/adr';
  const all = readdirSync(join(process.cwd(), dir)).filter((f) => f.endsWith('.md'));
  // The index is not itself a decision record.
  const files = all.filter((f) => f !== 'README.md');

  it('exist for the decisions a reviewer would question', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s says what it rejected, not only what it chose', (file) => {
    // An ADR without the alternatives is a note, not a decision record: the
    // next person cannot tell whether their idea was considered or missed.
    const text = read(join(dir, file));
    expect(text).toMatch(/## Why/);
    expect(text.length).toBeGreaterThan(400);
  });

  it('are all reachable from the index, so none is orphaned', () => {
    // An unlinked decision record is a decision nobody will find at the moment
    // they are about to undo it.
    const index = read('docs/adr/README.md');
    for (const f of files) {
      expect(index).toContain(f);
    }
  });
});
