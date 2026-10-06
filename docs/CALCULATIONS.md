# Calculation glossary

All intervals use inclusive start/exclusive end; timestamps use UTC. Decimal.js performs financial/FTE arithmetic in the calculation library. PostgreSQL uses numeric for aggregate arithmetic.

- Unique people: count distinct stable worker UUIDs in the authorized cohort; do not sum overlapping org/skill dimensions.
- Home headcount: unique active people in their primary home organization on the chosen date.
- Contracted FTE: effective contract FTE. Missing contracts mean unknown, never free capacity.
- Work-eligible FTE: contracted FTE × max(0, 1 − approved unavailable fractions). Calendar working days must be applied for period rollups; complete calendar-aware SQL reporting remains outstanding.
- Allocation FTE: eligible FTE × assignment fraction. Planned work belongs to forecast; committed/actual are live allocation categories. 0.4 + 0.6 of one 1.0 FTE worker totals 1.0 FTE and one person.
- Available FTE: max(0, eligible − committed allocation), subject to manager confirmation, constraints, evidence freshness and skills. This is an investigation measure, not a recommendation to move a person.
- Approved demand gap: max(0, approved requested FTE − qualifying approved fulfillment in overlapping dates). 2.0 − 0.5 = 1.5.
- Period average FTE: sum(segment FTE × applicable workdays) / selected-period workdays. Person-days is the numerator, a different unit.
- Loaded cost: (annualized base × paid FTE + annual bonus) × (1 + burden percent / 100) × FX × period days / year days. Rate frequency and weekly schedule are explicit. Hourly basis requires actual contracted hours; historical FX uses the applicable as-of record.
- Movement impact: source allocation decreases and destination allocation increases. An internal allocation transfer creates zero automatic enterprise payroll savings. Avoided external hiring requires an explicit counterfactual and confidence.
- Suppressed cohorts: displayed as suppressed, never zero. The current monthly finance endpoint is a forecast using month-start rates, not a complete daily actual-payroll calculation. Full period changes and overlap-differencing protection remain required.
