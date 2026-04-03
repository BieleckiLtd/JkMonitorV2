import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function supportsViewTransitions() {
  return typeof document !== 'undefined' && 'startViewTransition' in document
}
