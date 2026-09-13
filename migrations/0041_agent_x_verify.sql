-- X/Twitter verification indexes for agent claims.
-- Columns may already exist from runtime schema ensure; indexes are idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS agent_claims_verification_code_idx
  ON agent_claims(verification_code)
  WHERE verification_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_claims_x_handle_idx
  ON agent_claims(x_handle)
  WHERE x_handle IS NOT NULL AND verified_at IS NOT NULL;
