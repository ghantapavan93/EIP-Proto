# Questions public research cannot answer

Grouped by what they decide. The first block decides whether this prototype
is useful or already solved.

## Does the problem exist?

1. When the 48-hour SOA rule ends on October 1, how will you find every
   script, scorecard item, prompt, page and training doc that references it —
   and how will you know you got them all?
2. Does a rule→artifact registry exist today, even as a spreadsheet? Who owns
   it, and what slipped in the last changeover?
3. Does the 28-item Attention scorecard still encode the "first minute"
   disclaimer timer, and who is updating it for October 1?

## Where do prompts and rules live?

4. Where do the prompts behind your sales workflows live — a repo, a vendor
   console, someone's Claude project — and what does "deploy a prompt change"
   mean at EIP?
5. Are your Attention scorecard definitions and expert-mode prompts versioned
   anywhere you own (TeamEIP Git), or only in the vendor console?
6. Is there any eval or prompt-versioning tool already paid for (Braintrust,
   LangSmith, Promptfoo, Snowflake evals), or is "create systematic testing
   approaches" in the JD literally starting from zero?

## The feedback loop

7. When Attention flags a call and a supervisor disagrees, where does that
   correction live today, and does it ever change a scorecard item or a
   prompt?
8. What is the false-positive rate on compliance alerts, and who looks at
   borderline calls before they count toward corrective action?

## Vendors and change

9. Which vendor change broke something on you this year, how did you find
   out, and what log did you wish you had?
10. Which AI and monitoring vendors are live today, and which stage of the
    customer journey does each own?
11. If OpenAI or Attention silently changed model behavior last Tuesday, how
    would you know — and how would you prove which side changed?

## Compliance reality

12. On the CY2027 recording rule, what did counsel conclude about
    enrollment calls — do they now fall back to the 10-year retention of
    422.504(d), since the new 6-year text in 422.2274(g)(2)(ii) covers
    marketing and sales calls only — and where does the retention store
    live?
13. Do Medicare and Life share scripts, QA rubrics and prompts, or are they
    forked — and who owns the Medigap (state DOI) versus MA (CMS) rule sets?
14. When a lead comes in with permission-to-contact for Medicare and the
    agent pivots to Life, how is consent scope enforced today?

## The team

15. What is the inventory of prototypes, automations and internal tools
    waiting to be productionized, and who built them on what?
16. Where does the handoff between the Enablement Specialist's spec and the
    Full Stack engineer's build hurt most?
17. If this harness ran on your Attention → Snowflake export after AEP, what
    is the first contract you would want it to check? (On unlabeled calls the
    rule-judgment contracts return ERROR; who could label a monthly sample?)
