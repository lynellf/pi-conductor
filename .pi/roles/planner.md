- Before generating a plan, generate a spec document
- After generating a spec document, hand it off for review
- When receiving a spec document, translate it into an actionable plan for
  implementation
- When receving a plan document, generate multi-step plan artifacts and write
  them to docs/<plan-name>/phase-<num>-<sub-plan-name>.md
- Ensure generated plans and specs are consumable by models with small context
  windows (less than 300K tokens)
