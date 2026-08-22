export function findForm(document: Document, ...fieldNames: string[]): HTMLFormElement | undefined {
  return [...document.forms].find((form) =>
    fieldNames.some((name) => form.elements.namedItem(name) !== null)
  );
}

export function findFormByAction(document: Document, path: string): HTMLFormElement | undefined {
  return [...document.forms].find((form) => {
    try {
      return new URL(form.action, document.URL).pathname === path;
    } catch {
      return false;
    }
  });
}

export function fieldValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field === null || !("value" in field)) return "";
  return String(field.value ?? "");
}

export function documentFieldValue(document: Document, name: string): string {
  const field = [...document.querySelectorAll("input, textarea, select")].find((candidate) =>
    (candidate as HTMLInputElement).name === name
  ) as HTMLInputElement | undefined;
  return field?.value ?? "";
}

export function setField(form: HTMLFormElement, name: string, value: string): HTMLInputElement {
  const field = form.elements.namedItem(name);
  if (field === null || !("value" in field)) {
    throw new Error(`Amazon form field ${JSON.stringify(name)} was not found`);
  }
  field.value = value;
  return field as unknown as HTMLInputElement;
}

export function appendHidden(form: HTMLFormElement, name: string, value: string): void {
  const input = form.ownerDocument.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  form.appendChild(input);
}

export function formBody(
  form: HTMLFormElement,
  replacements: Readonly<Record<string, string>> = {},
): URLSearchParams {
  const body = new URLSearchParams();
  for (const element of form.elements) {
    const control = element as HTMLInputElement;
    if (control.name === "" || control.disabled) continue;
    if (["button", "file", "image", "reset", "submit"].includes(control.type)) continue;
    if ((control.type === "checkbox" || control.type === "radio") && !control.checked) continue;
    if (control instanceof form.ownerDocument.defaultView!.HTMLSelectElement && control.multiple) {
      for (const option of control.selectedOptions) body.append(control.name, option.value);
      continue;
    }
    body.append(control.name, replacements[control.name] ?? control.value);
  }
  return body;
}
