/**
 * A model id that may wrap after its provider prefix in narrow cells:
 * "ollama/" + <wbr> + "qwen2.5:7b-instruct". Ids without a "/" render as-is.
 */
export function ModelId({ id }: { id: string }) {
  const slash = id.indexOf('/');
  if (slash < 0) return <>{id}</>;
  return (
    <>
      {id.slice(0, slash + 1)}
      <wbr />
      {id.slice(slash + 1)}
    </>
  );
}
