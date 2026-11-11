// Verify the original SDK entry points used by owned native worker frames.
const {check} = require('./session.cjs');
const {loadTarget} = require('../../shared/target.cjs');
const table = require('./thread-code.json');
const code = table.functions;
const directNnOs = table.directNnOs;
const rawSvc = table.rawSvc;
code.exitContinuation = directNnOs?.functions.exitContinuation;
if (rawSvc?.functions?.exitThread) code.rawExitContinuation = rawSvc.functions.exitThread;
const {SENTINEL} = require('../../shared/frames.cjs');

async function verifyWorkerCode(session) {
  const target = loadTarget();
  const names = ['current', 'longjmp', 'loadTable', 'call4', 'saveResult64',
    'tryWait', 'tryWaitImplementation', 'sleep'];
  if (target.thread?.mode === 'raw-svc') {
    check(rawSvc?.functions && rawSvc.managerList, 'Missing raw-svc worker signatures');
    for (const [name, expected] of Object.entries(rawSvc.functions))
      await session.verifyCode(expected, 'Raw svc ' + name);
    names.length = 0;
    names.push('longjmp', 'loadTable', 'call4', 'saveResult64', 'sleep');
  } else if (target.thread?.mode === 'direct-nnos') {
    check(directNnOs?.functions, 'Missing direct nn::os worker signatures');
    for (const [name, expected] of Object.entries(directNnOs.functions))
      await session.verifyCode(expected, 'Direct nn::os ' + name);
  } else if (target.thread?.mode === 'pthread-enumerate') {
    names.push('create', 'exit');
    check(directNnOs?.functions?.destroy, 'Missing manager-list destroy signature');
    await session.verifyCode(directNnOs.functions.destroy, 'Manager-list DestroyThread');
  } else names.push('create', 'join', 'exit');
  for (const name of names) {
    check(code[name], 'Missing worker signature: ' + name);
    await session.verifyCode(code[name], name);
  }
  await session.record({operation: 'workerCodeVerified', mode: target.thread?.mode || 'pthread'});
}
module.exports = {verifyWorkerCode, code, directNnOs, rawSvc, managerListRecovery: table.managerListRecovery, SENTINEL};
