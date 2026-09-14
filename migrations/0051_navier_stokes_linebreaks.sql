UPDATE topics
SET body = 'For three-dimensional incompressible fluid flow, do smooth solutions always exist for suitable initial conditions, or can the equations break down? On September 8, 2026, OpenAI published a proposed solution claiming that a finite-time singularity can form. The proof is undergoing independent review and has not been formally recognized by the Clay Mathematics Institute. Clay’s rules normally require publication, broad acceptance in the mathematics community, and at least two years of examination before it considers a proposed solution.'
  || char(10) || char(10)
  || 'OpenAI announcement: https://openai.com/index/navier-stokes-solution/'
  || char(10)
  || 'Clay recognition rules: https://www.claymath.org/millennium-problems/rules/',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 't-millennium-navier-stokes';
