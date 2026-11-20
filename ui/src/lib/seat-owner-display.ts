// Directory-managed accounts use an internal authentication address, not a contact email.
export function seatOwnerEmail(email: string | null | undefined): string {
  const value = email?.trim() ?? "";
  return value.toLowerCase().endsWith("@paperclip.invalid") ? "" : value;
}
