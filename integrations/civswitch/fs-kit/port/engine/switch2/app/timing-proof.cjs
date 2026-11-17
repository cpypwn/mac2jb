function validatedGravityCircuitProof(raw, addresses, target, now = Date.now()) {
  let proof;
  try { proof = JSON.parse(raw); }
  catch { throw Error('Gravity Circuit atomic timing proof is missing'); }

  const elapsedTicks = proof?.elapsedTicks;
  const measuredFrequency = elapsedTicks * 1e9 / proof?.intervalNs;
  const tolerance = target.timing.nativeFrequency * target.timing.tolerancePpm / 1e6;
  const valid = proof && proof.gameProfile === 'gravity-circuit-v1.2.1' &&
    proof.sdkBase === addresses.sdk && proof.scratch === addresses.scratch &&
    proof.sdkCrc32 === addresses.sdkCrc32 && proof.sdkCrc32 === target.hello.sdkCrc32 &&
    proof.sdkFrequency === target.timing.sdkFrequency &&
    proof.nativeFrequency === target.timing.nativeFrequency &&
    proof.intervalNs === target.timing.measurementNs &&
    proof.tolerancePpm === target.timing.tolerancePpm &&
    proof.fsBridgeStage === 'accept' && /^[0-9a-f]{16}$/.test(proof.nonce) &&
    Number.isSafeInteger(proof.issuedAt) && proof.issuedAt <= now &&
    now - proof.issuedAt <= 20 * 60 * 1000 &&
    Number.isSafeInteger(elapsedTicks) && elapsedTicks > 0 &&
    Number.isFinite(measuredFrequency) &&
    Math.abs(proof.measuredFrequency - measuredFrequency) < 1e-6 &&
    Math.abs(measuredFrequency - target.timing.nativeFrequency) <= tolerance;
  if (!valid) throw Error('Gravity Circuit atomic timing proof does not match this paired session');
  return proof;
}

module.exports = {validatedGravityCircuitProof};
