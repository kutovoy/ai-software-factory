/**
 * One heading source for every factory page: the manifest alias, falling back to the
 * directory name (path-is-identity). Pages must not each invent their own label.
 */
export function factoryLabel(alias: string | null | undefined, name: string): string {
  return alias && alias.trim().length > 0 ? alias : name;
}

/** `Label › Section`, the shared factory-page heading. */
export function factoryHeading(alias: string | null | undefined, name: string, section: string): string {
  return `${factoryLabel(alias, name)} › ${section}`;
}

/** Correct singular/plural for a count. */
export function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
