# Workforce planning user guide

Use **People needing a role**, **Teams needing people**, **Find matches** and **Transfers** to retain people through internal moves. **Overview** shows real permission-scoped counts. People & skills, imports and administration support those journeys. Legacy modules remain accessible for compatibility but are outside the active product scope.

Your organization must configure Microsoft Entra sign-in and scoped access. Open `/login` and choose **Continue with Microsoft Entra**. The **As of** date determines which record revision and organization/reporting relationships you see. Dates start inclusively and end exclusively. [Testing instructions](TESTING.md) explain the synthetic test runner and tenant setup.

## People needing a role

A manager or HR user with the appropriate permissions can select **Add person needing a role**, search for the team and person, and specify the reason, available date, optional placement deadline, location, work mode, relocation preference and FTE. **Consider for internal roles** defaults to Yes. The employee does not need to request or know about the flag. Flagging does not change employment, identity or salary.

Use **Consider** or **Stop considering** in the list to change eligibility at the selected planning date. The consideration filter shows eligible or ineligible people. After a committed placement, the record is marked placed; an authorized manager or HR user can flag it again later. Historical views keep earlier decisions. A role label alone does not authorize the operation: consideration changes require `FLAG_FOR_ROLES` plus the normal scoped write permission.

## Teams needing people

Select **Add team request** and provide the role, reason, requested FTE/headcount, location/work mode and needed dates. Optional annual base salary budget and currency describe the full-time salary cap per person. Search and add required skills in the same form; they are saved atomically with the request. Existing requirements can be maintained in the Request skills tab.

Open the request and **submit** it. Independent reviewers select the appropriate approval stage, enter a decision note if needed, and **approve**, **return** or **reject**. The server enforces the configured stages, scope and independent reviewers. An approved need can be used for a transfer proposal.

## Find matches and propose a transfer

Select a team request and **Find matches**. The table shows considered people visible to you, using their planning resource codes. Review skills, dates, location, FTE and salary evidence. Missing or restricted evidence remains unknown. Salary comparisons require separate permission and do not change who appears or their ordering. Nothing automatically selects someone for redundancy or changes employment.

Select **Propose transfer** for a person, choose the receiving manager and effective date, and provide the reason. **Save transfer proposal** captures the current versions on the server. Follow **Review and submit proposal** to Transfers. Review gaps with both teams and the person before submitting.

## Approve and commit

Transfers uses the existing staged approval policy. Each stage needs its specific scoped approval permission, and the creator cannot approve their own proposal. Once approved, an authorized committer chooses **commit** explicitly. A permanent transfer moves the whole primary assignment and the home team, changes the manager relationship, clears consideration, and records fulfillment. It preserves historical views and protected identity/pay values. It schedules no return to the source team. Finite team needs bound fulfillment, and existing employment end dates stay intact.

Stale records, other committed allocations, leave/constraints, future profile/pay revisions or insufficient confirmed capacity can require a revised proposal. A denied or failed commit rolls back all changes. Scope relocation of protected records requires separate permissions and grants no salary or identity reading access. The workflow changes internal planning records; it does not update payroll or Entra.

## Supporting records and history

People & skills maintains planning profiles, verified skills, roles and teams. Reference pickers search permitted records; protected names and salaries are not copied into planning profiles. Open a record to inspect its dates and **History**. Writes use optimistic versions, so concurrent changes produce a conflict instead of silently overwriting someone else's work.

HR Import Center provides templates, preview validation and explicit commit through the durable worker. Imported flags use the same permissions as direct edits. Administration and access changes are independently authorized; sensitive grants require the existing independent approval process. See [imports](IMPORTS.md), [Entra setup](ENTRA.md) and [testing](TESTING.md).

The executed checks and remaining production limitations are recorded in [the implementation matrix](../IMPLEMENTATION_MATRIX.md). Passing the synthetic workflow does not establish live Entra, external-system, deployment, accessibility or load acceptance.
