export function replaceOnce(body: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (oldString.length === 0) throw new Error("old_string 不能为空。");
  const count = body.split(oldString).length - 1;
  if (count === 0) throw new Error("old_string 未找到。");
  if (count > 1 && !replaceAll) throw new Error("old_string 出现多次；请加长或用 replace_all。");
  return replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, () => newString);
}
