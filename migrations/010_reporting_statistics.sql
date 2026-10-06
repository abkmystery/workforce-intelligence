-- JSON expressions otherwise get generic selectivity, even after ANALYZE.
-- Measured capacity plans estimated 1,000 active workers in a 100k cohort.
CREATE STATISTICS workers_employment_status ON (data->>'employmentStatus') FROM workers;
CREATE STATISTICS availability_approved ON (data->>'approved') FROM availability;
ANALYZE workers;
ANALYZE availability;
