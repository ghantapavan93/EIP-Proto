import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GateChip } from '../components/runs/GateChip';
import { gateTone, outcomeTone, directionTone } from '../lib/vocab';

describe('GateChip', () => {
  it.each([
    ['GREEN', 'green'],
    ['AMBER', 'amber'],
    ['RED', 'red'],
    ['GREY', 'neutral'],
  ])('maps gate %s to tone %s with a solid fill', (gate, tone) => {
    render(<GateChip gate={gate} />);
    const chip = screen.getByText(gate);
    expect(chip).toHaveAttribute('data-tone', tone);
    expect(chip).toHaveAttribute('data-filled', 'true');
  });

  it('falls back to GREY for null or unknown gates', () => {
    render(<GateChip gate={null} />);
    expect(screen.getByText('GREY')).toHaveAttribute('data-tone', 'neutral');
    expect(gateTone('PURPLE')).toBe('neutral');
  });

  it('keeps red strictly for FAIL/ERROR/under-restrictive', () => {
    expect(outcomeTone('PASS')).toBe('green');
    expect(outcomeTone('FLAG')).toBe('amber');
    expect(outcomeTone('FAIL')).toBe('red');
    expect(outcomeTone('ERROR')).toBe('red');
    expect(directionTone('under_restrictive')).toBe('red');
    expect(directionTone('over_restrictive')).toBe('amber');
    expect(directionTone('reverify')).toBe('slate');
  });
});
