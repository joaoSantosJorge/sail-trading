import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 0x1234…abcd — canonical short form for wallet addresses. */
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
