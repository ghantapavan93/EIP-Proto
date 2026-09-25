import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HighlightedText } from '../components/ui/HighlightedText';
import { segmentText } from '../lib/spans';

const TEXT = 'The monthly premium is $12.40, and it includes dental.';

describe('HighlightedText', () => {
  it('renders a verified span as a teal mark with the label as tooltip', () => {
    render(
      <HighlightedText
        text={TEXT}
        spans={[{ offset: 4, length: 25, label: 'premium_claim', verified: true }]}
      />,
    );
    const marks = screen.getAllByTestId('hl-span');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('monthly premium is $12.40');
    expect(marks[0]).toHaveAttribute('data-verified', 'true');
    expect(marks[0]).toHaveAttribute('title', 'premium_claim');
    expect(marks[0].className).toContain('mark-span');
    expect(marks[0].className).not.toContain('mark-span-unverified');
  });

  it('renders an unverified span red with a "not found in transcript" tag', () => {
    render(
      <HighlightedText
        text={TEXT}
        spans={[{ offset: 23, length: 6, label: 'hallucinated', verified: false }]}
      />,
    );
    const mark = screen.getByTestId('hl-span');
    expect(mark).toHaveTextContent('$12.40');
    expect(mark).toHaveAttribute('data-verified', 'false');
    expect(mark.className).toContain('mark-span-unverified');
    expect(screen.getByText('not found in transcript')).toBeInTheDocument();
  });

  it('splits overlapping spans into disjoint segments and keeps every label', () => {
    // "monthly premium is $12.40" [4, 29) overlaps "$12.40, and it" [23, 37)
    const spans = [
      { offset: 4, length: 25, label: 'premium_claim', verified: true },
      { offset: 23, length: 14, label: 'numeric', verified: false },
    ];
    const segments = segmentText(TEXT, spans);
    const covered = segments.filter((s) => s.covering.length > 0);
    expect(covered.map((s) => TEXT.slice(s.start, s.end))).toEqual([
      'monthly premium is ',
      '$12.40',
      ', and it',
    ]);
    expect(covered[1].covering.map((s) => s.label)).toEqual(['premium_claim', 'numeric']);

    render(<HighlightedText text={TEXT} spans={spans} tagUnverified={false} />);
    const marks = screen.getAllByTestId('hl-span');
    expect(marks).toHaveLength(3);
    // the overlap carries both labels and reads unverified because one covering span is unverified
    expect(marks[1]).toHaveAttribute('data-labels', 'premium_claim,numeric');
    expect(marks[1]).toHaveAttribute('data-verified', 'false');
    expect(marks[0]).toHaveAttribute('data-verified', 'true');
    // full text is preserved end to end
    expect(document.body.textContent).toContain(TEXT);
  });

  it('ignores spans with a negative offset (cited but not locatable)', () => {
    render(<HighlightedText text={TEXT} spans={[{ offset: -1, length: 5, label: 'ghost', verified: false }]} />);
    expect(screen.queryByTestId('hl-span')).toBeNull();
  });
});
