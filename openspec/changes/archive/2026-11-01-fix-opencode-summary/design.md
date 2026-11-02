# Design

## Decisions

1. **Summary from the final assistant text.** `session.text.ended` / `session.next.text.ended`
   already carry the complete message; the mapper remembers it and attaches it to the successful
   `run.completed` event. Error/cancel summaries keep their existing causes.
2. **Optional field.** Runs with no assistant text still complete without a summary; the verdict
   parser then applies the factory policy (`advisory` or `required`).
3. **Contract parity.** The fake adapter scenario supplies the same summary so the canonical
   sequence comparison stays exact.
