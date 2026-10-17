import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, letting a caller's utility win over a component's default.
 *
 * `clsx` flattens conditionals, `twMerge` resolves Tailwind conflicts — so passing `p-0` to a
 * component whose base is `p-4` gives `p-0` rather than both.
 *
 * @param inputs Class values: strings, arrays, or conditional objects.
 * @returns One class string with conflicts resolved.
 *
 * @example
 * cn('p-4 text-muted', isActive && 'text-primary', className);
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
