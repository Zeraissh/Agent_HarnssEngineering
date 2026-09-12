/**
 * features/theme-select — 把原生 <select> 收成自绘菜单。
 *
 * Windows 上原生弹出层不吃页面主题：暗色界面会白底浅字（--text-1 是浅色，
 * 系统菜单却是白底）。工作目录 / 执行模型已经各自画过菜单；其余下拉走这里，
 * 隐藏的 <select> 仍是事实源（.value / change / 表单提交）。
 *
 * 已是 sr-only + aria-hidden 的（workdir / executor）不升级。
 */

let openApi = null;

function closeOpen() {
  openApi?.close();
  openApi = null;
}

function optionList(select) {
  return [...select.options].map((opt, index) => ({
    value: opt.value,
    label: opt.label || opt.textContent || opt.value,
    disabled: opt.disabled,
    hidden: opt.hidden,
    index,
  }));
}

function copyName(select, trigger) {
  const labelledBy = select.getAttribute("aria-labelledby");
  if (labelledBy) {
    trigger.setAttribute("aria-labelledby", labelledBy);
    return;
  }
  const label = select.getAttribute("aria-label");
  if (label) {
    trigger.setAttribute("aria-label", label);
    return;
  }
  if (!select.id) return;
  const forEl = select.ownerDocument.querySelector(`label[for="${select.id}"]`);
  if (!forEl) return;
  const caption = forEl.querySelector("span")?.textContent?.trim()
    || (!forEl.contains(select) ? forEl.textContent.trim() : "");
  if (caption) trigger.setAttribute("aria-label", caption);
}

function placeMenu(trigger, menu) {
  const r = trigger.getBoundingClientRect();
  const gap = 4;
  const vw = trigger.ownerDocument.defaultView ?? window;
  menu.style.position = "fixed";
  menu.style.minWidth = `${Math.max(r.width, 140)}px`;
  menu.style.maxWidth = `${Math.min(360, vw.innerWidth - 16)}px`;
  menu.style.maxHeight = `${Math.min(280, Math.max(120, vw.innerHeight - 24))}px`;
  const spaceBelow = vw.innerHeight - r.bottom - gap;
  const spaceAbove = r.top - gap;
  if (spaceBelow < 160 && spaceAbove > spaceBelow) {
    menu.style.top = "auto";
    menu.style.bottom = `${vw.innerHeight - r.top + gap}px`;
  } else {
    menu.style.bottom = "auto";
    menu.style.top = `${r.bottom + gap}px`;
  }
  const width = menu.offsetWidth || r.width;
  let left = r.left;
  if (left + width > vw.innerWidth - 8) left = Math.max(8, vw.innerWidth - width - 8);
  if (left < 8) left = 8;
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
}

/**
 * @param {HTMLSelectElement} select
 * @returns {{ refresh:()=>void, close:()=>void, destroy:()=>void, wrapper:HTMLElement }|null}
 */
export function initThemeSelect(select) {
  if (!(select instanceof HTMLSelectElement)) return null;
  if (select.closest(".theme-select")) return select._themeSelect ?? null;
  if (select.classList.contains("sr-only") && select.getAttribute("aria-hidden") === "true") {
    return null;
  }

  const doc = select.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "theme-select";
  select.parentNode?.insertBefore(wrapper, select);
  wrapper.appendChild(select);

  const menuId = `${select.id || "theme-select"}-menu`;
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "theme-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  copyName(select, trigger);

  select.classList.add("sr-only");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;
  select.removeAttribute("aria-labelledby");
  select.removeAttribute("aria-label");
  if (select.classList.contains("run-filter")) {
    select.classList.remove("run-filter");
    wrapper.classList.add("theme-select--filter");
  }
  const valueEl = doc.createElement("span");
  valueEl.className = "theme-select-value";
  const caret = doc.createElement("span");
  caret.className = "theme-select-caret";
  caret.setAttribute("aria-hidden", "true");
  trigger.appendChild(valueEl);
  trigger.appendChild(caret);

  const menu = doc.createElement("div");
  menu.id = menuId;
  menu.className = "theme-select-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);

  let activeIndex = -1;

  function selectedLabel() {
    const opt = select.selectedOptions[0];
    return (opt?.label || opt?.textContent || "").trim() || "选择";
  }

  function paintTrigger() {
    valueEl.textContent = selectedLabel();
    trigger.disabled = select.disabled;
    trigger.title = select.title || selectedLabel();
  }

  function paintOptions() {
    const items = optionList(select).filter((o) => !o.hidden);
    menu.replaceChildren();
    for (const item of items) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "theme-select-option";
      btn.setAttribute("role", "option");
      btn.dataset.value = item.value;
      btn.disabled = item.disabled;
      const selected = item.value === select.value;
      btn.setAttribute("aria-selected", String(selected));
      if (selected) btn.classList.add("is-selected");
      btn.textContent = item.label;
      btn.addEventListener("click", () => choose(item.value));
      menu.appendChild(btn);
    }
  }

  function refresh() {
    paintTrigger();
    paintOptions();
    if (!menu.hidden) placeMenu(trigger, menu);
  }

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    trigger.removeAttribute("aria-controls");
    if (openApi === api) openApi = null;
  }

  function open() {
    if (select.disabled) return;
    if (openApi && openApi !== api) openApi.close();
    paintOptions();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", menuId);
    placeMenu(trigger, menu);
    openApi = api;
    const current = menu.querySelector(".theme-select-option.is-selected")
      ?? menu.querySelector(".theme-select-option");
    if (current instanceof HTMLElement) {
      activeIndex = [...menu.children].indexOf(current);
      current.focus();
    }
  }

  function choose(value) {
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    paintTrigger();
    close();
    trigger.focus();
  }

  function move(delta) {
    const items = [...menu.querySelectorAll(".theme-select-option:not(:disabled)")];
    if (items.length === 0) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    items[activeIndex].focus();
  }

  trigger.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (menu.hidden) open();
      else move(event.key === "ArrowDown" ? 1 : -1);
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); activeIndex = -1; move(1); }
    else if (event.key === "End") { event.preventDefault(); activeIndex = 0; move(-1); }
    else if (event.key === "Escape") { event.preventDefault(); close(); trigger.focus(); }
    else if (event.key === "Enter" || event.key === " ") {
      const focused = doc.activeElement;
      if (focused instanceof HTMLElement && focused.classList.contains("theme-select-option")) {
        event.preventDefault();
        choose(focused.dataset.value ?? "");
      }
    }
  });

  const onDocPointer = (event) => {
    if (menu.hidden) return;
    const t = event.target;
    if (t instanceof Node && wrapper.contains(t)) return;
    close();
  };
  const onViewport = () => { if (!menu.hidden) close(); };
  doc.addEventListener("pointerdown", onDocPointer);
  (doc.defaultView ?? window).addEventListener("resize", onViewport);
  (doc.defaultView ?? window).addEventListener("scroll", onViewport, true);

  select.addEventListener("change", paintTrigger);
  const mo = new MutationObserver(refresh);
  mo.observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "title"],
  });

  const api = {
    refresh,
    close,
    destroy() {
      close();
      mo.disconnect();
      doc.removeEventListener("pointerdown", onDocPointer);
      (doc.defaultView ?? window).removeEventListener("resize", onViewport);
      (doc.defaultView ?? window).removeEventListener("scroll", onViewport, true);
      wrapper.parentNode?.insertBefore(select, wrapper);
      wrapper.remove();
      select.classList.remove("sr-only");
      select.removeAttribute("aria-hidden");
      select.tabIndex = 0;
      delete select._themeSelect;
    },
    wrapper,
  };
  select._themeSelect = api;
  refresh();
  return api;
}

/**
 * 把根节点里还露着的原生 <select> 全部升级。已自绘 / 已隐藏的跳过。
 * @param {ParentNode} root
 */
export function upgradeSelects(root) {
  const selects = [...root.querySelectorAll("select")];
  return selects.map((el) => initThemeSelect(el)).filter(Boolean);
}
