// Persist the pending native operation before sending it. A disconnect must
// leave the last attempted call distinguishable from a returned call.
function journal(record, save) {
  record.operations ||= [];
  return async function tracked(name, args, action) {
    const row={name,args:args.map(x=>typeof x==='bigint'?x.toString():x),started:new Date().toISOString(),status:'pending'};
    record.operations.push(row);
    await save();
    try {
      const result=await action();
      row.result=typeof result==='bigint'?result.toString():result;
      row.status='returned';
      return result;
    } catch(error) {
      row.status='failed';row.error=error.message;
      throw error;
    } finally {row.completed=new Date().toISOString();await save();}
  };
}
module.exports={journal};
