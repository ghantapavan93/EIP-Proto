import { describe, expect, it } from 'vitest';
import { explainRuleVerdict } from '../lib/evidence';

/** "Why is this red?" is recomputed from stored evidence and never contradicts the contract. */
describe('explainRuleVerdict', () => {
  const tpmo = {
    expected: true,
    got: false,
    rule_logic: { basis: 'ordering', window_seconds: 0 },
    disclaimer_seconds: 25,
    benefits_started_seconds: 131,
    model_disclaimer_seconds: 25,
  };

  it('names the comparison and calls out a verdict that contradicts the extracted evidence', () => {
    const why = explainRuleVerdict(tpmo, 'FAIL');
    expect(why?.check).toBe('25s < 131s → disclaimer before benefits → compliant');
    expect(why?.finding).toMatch(/read the disclaimer at 25s, which is correct, and still answered violation/);
  });

  it('distinguishes a misread time from a wrong conclusion', () => {
    expect(explainRuleVerdict({ ...tpmo, model_disclaimer_seconds: 140 }, 'FAIL')?.finding).toMatch(/misread the disclaimer time/);
  });

  it('stays silent rather than disagree with the stored ground truth', () => {
    expect(explainRuleVerdict({ ...tpmo, expected: false }, 'FAIL')).toBeNull();
    expect(explainRuleVerdict({ ...tpmo, not_applicable: 'Medigap' }, 'PASS')).toBeNull();
  });

  it('explains the SOA wait under the rule in force', () => {
    const why = explainRuleVerdict({ expected: false, got: true, rule_logic: { min_hours: 48 }, appointment_hours_after_soa: 3, soa_exception: null }, 'FAIL');
    expect(why?.check).toBe('3h < 48h wait → violation');
  });
});
