const pending = new Map<string, Promise<unknown>>();
/** Serialize saves to the same resource so an old response cannot overwrite a new edit. */
export function enqueueSave<T>(key: string, save: () => Promise<T>): Promise<T> {
  const job = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(save);
  pending.set(key, job);
  void job.finally(() => { if (pending.get(key) === job) pending.delete(key) }).catch(() => undefined);
  return job;
}
