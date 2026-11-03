/**
 * A flow picker you can search: typing narrows the list to flows whose label
 * or API name contains every word typed. It picks elements just as well,
 * given another noun. Options are { label, value }, as for
 * lightning-combobox, and picking one fires change { value } from the host,
 * so data-* attributes set on the picker still reach the handler.
 */
import { LightningElement, api } from "lwc";
import { visibleText } from "c/flowUtils";

// Room the menu needs below the field before it opens upward instead.
const MENU_ROOM = 280;
// A long list shows this many options at first, and this many more as it's
// scrolled near either end. The keyboard, or opening at a chosen option far
// down, shows the page it's on. Every option stays reachable, and each says
// where it is in the whole list.
const PAGE = 50;
// The most options shown at once; scrolling on lets go of those furthest away.
const MOST_SHOWN = 3 * PAGE;
// How near either end of what's shown a scroll shows more, in pixels.
const MORE_AHEAD = 200;

function searchText(option) {
  const value = option.value || "";
  return `${option.label || ""} ${value} ${value.replace(/_/g, " ")}`.toLowerCase();
}

export default class FlowPicker extends LightningElement {
  @api label;
  @api placeholder = "Choose a flow";
  /** What the options are, for the empty list: "No flows match …". */
  @api noun = "flows";
  @api disabled = false;
  @api required = false;

  _options = [];
  _value;
  // What's typed in the box; undefined until the user types.
  query;
  open = false;
  activeIndex = -1;
  // Which of the matches are listed: from first up to, not including, shown.
  first = 0;
  shown = PAGE;
  // The option at the top of the menu, and how far down it was, while what's
  // listed changes around it.
  _anchor;
  menuStyle = "";
  _scrollActive = false;
  _place = () => this.place();
  // Derived values, kept while their inputs are the same: typing filters
  // the list once, and moving through it doesn't filter it again.
  _cache = {};

  @api
  get options() {
    return this._options;
  }
  set options(value) {
    const active = this.matches[this.activeIndex]?.value;
    this._options = Array.isArray(value) ? value : [];
    // What each option is searched by, made once per list.
    this._cache.searchable = undefined;
    if (this.open) {
      const matches = this.matches;
      const retained = matches.findIndex((option) => option.value === active);
      this.activeIndex = retained >= 0 ? retained : matches.length ? 0 : -1;
      this.reveal();
      this._scrollActive = true;
    }
  }

  @api
  get value() {
    return this._value;
  }
  set value(value) {
    this._value = value;
  }

  disconnectedCallback() {
    this.unlisten();
  }

  renderedCallback() {
    if (this._anchor) {
      const { index, offset } = this._anchor;
      this._anchor = undefined;
      const menu = this.template.querySelector(".menu");
      const option = this.template.querySelector(
        `.option[data-index="${index}"]`
      );
      if (menu && option) {
        menu.scrollTop = option.offsetTop - offset;
      }
    }
    if (this._scrollActive) {
      this._scrollActive = false;
      const menu = this.template.querySelector(".menu");
      const option = this.template.querySelector(".option-active");
      if (menu && option) {
        const top = option.offsetTop;
        const bottom = top + option.offsetHeight;
        if (top < menu.scrollTop) {
          menu.scrollTop = top;
        } else if (bottom > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = bottom - menu.clientHeight;
        }
      }
    }
  }

  get selected() {
    return this.memo("selected", [this._options, this._value], () =>
      this._options.find((option) => option.value === this._value)
    );
  }

  get inputValue() {
    if (this.query !== undefined) {
      return this.query;
    }
    return this.selected ? visibleText(this.selected.label) : "";
  }

  memo(name, inputs, build) {
    const entry = this._cache[name];
    if (entry && entry.inputs.every((input, i) => input === inputs[i])) {
      return entry.value;
    }
    const value = build();
    this._cache[name] = { inputs, value };
    return value;
  }

  get searchable() {
    if (!this._cache.searchable) {
      this._cache.searchable = this._options.map((option) => ({
        option,
        text: searchText(option),
        names: [
          option.label || "",
          option.value || "",
          (option.value || "").replace(/_/g, " ")
        ].map((name) => name.toLowerCase().trim().replace(/\s+/g, " "))
      }));
    }
    return this._cache.searchable;
  }

  get matches() {
    const query = (this.query || "").toLowerCase();
    return this.memo("matches", [this._options, query], () => {
      const words = query.split(/\s+/).filter(Boolean);
      const phrase = words.join(" ");
      return words.length
        ? this.searchable
            .filter(({ text }) => words.every((word) => text.includes(word)))
            .map(({ option, names }) => ({
              option,
              rank: names.includes(phrase)
                ? 0
                : names.some((name) => name.includes(phrase))
                  ? 1
                  : 2
            }))
            .sort((a, b) => a.rank - b.rank)
            .map(({ option }) => option)
        : this._options;
    });
  }

  // Made once per list of matches and choice. Moving through the list
  // changes only the item it leaves and the one it comes to.
  get items() {
    const { matches } = this;
    const { first } = this;
    const listed = this.memo(
      "listed",
      [matches, this._value, first, this.shown],
      () =>
        matches
          .slice(first, this.shown)
          .map((option, index) => this.item(option, first + index, false))
    );
    const active = this.activeIndex;
    return this.memo("items", [listed, active], () => {
      if (!listed[active - first]) {
        return listed;
      }
      const items = [...listed];
      items[active - first] = this.item(matches[active], active, true);
      return items;
    });
  }

  item(option, index, active) {
    const chosen = option.value === this._value;
    return {
      key: option.value,
      id: `option-${index}`,
      index,
      position: index + 1,
      label: visibleText(option.label),
      value: option.value,
      chosen,
      ariaSelected: active ? "true" : "false",
      className: [
        "option",
        active ? "option-active" : "",
        chosen ? "option-chosen" : ""
      ]
        .filter(Boolean)
        .join(" ")
    };
  }

  get hasItems() {
    return this.matches.length > 0;
  }

  get matchCount() {
    return this.matches.length;
  }

  // Said at the end of a long list, so it's clear there's more of it.
  get moreText() {
    const count = this.matches.length;
    return count > this.shown
      ? `Showing ${this.first + 1}–${this.shown} of ${count}. Scroll for more, or type to narrow the list.`
      : "";
  }

  // Said at the top when the list starts further down.
  get earlierText() {
    return this.first > 0
      ? `${this.first} before these. Scroll up to show them.`
      : "";
  }

  // Lists the page the active option is on, when it isn't listed already.
  reveal() {
    const active = this.activeIndex;
    if (active >= 0 && (active < this.first || active >= this.shown)) {
      this.first = Math.floor(active / PAGE) * PAGE;
      this.shown = this.first + PAGE;
    }
  }

  // Lists the next page, letting go of the first when there'd be too many.
  showLater() {
    this.keepPlace();
    this.shown += PAGE;
    if (this.shown - this.first > MOST_SHOWN) {
      this.first += PAGE;
    }
  }

  // Lists the page before, letting go of the last when there'd be too many.
  showEarlier() {
    this.keepPlace();
    this.first = Math.max(0, this.first - PAGE);
    if (this.shown - this.first > MOST_SHOWN) {
      this.shown -= PAGE;
    }
  }

  // Notes the option at the top of the menu, so it stays put as options
  // are added or let go of around it.
  keepPlace() {
    const menu = this.template.querySelector(".menu");
    if (!menu) {
      return;
    }
    const top = [...this.template.querySelectorAll(".option")].find(
      (option) => option.offsetTop + option.offsetHeight > menu.scrollTop
    );
    if (top) {
      this._anchor = {
        index: top.dataset.index,
        offset: top.offsetTop - menu.scrollTop
      };
    }
  }

  get emptyText() {
    return this.query
      ? `No ${this.noun} match “${this.query.trim()}”`
      : `No ${this.noun}`;
  }

  get statusText() {
    if (!this.open || this.query === undefined) {
      return "";
    }
    const count = this.matches.length;
    return `Matching ${this.noun}: ${count}`;
  }

  // Only a listed option can be named as the active one.
  get activeId() {
    const active = this.activeIndex;
    return this.open && active >= this.first && active < this.shown
      ? `option-${active}`
      : undefined;
  }

  get expanded() {
    return this.open ? "true" : "false";
  }

  get isRequired() {
    return this.required !== false && this.required !== "false";
  }

  get comboboxClass() {
    return `slds-combobox slds-dropdown-trigger slds-dropdown-trigger_click${
      this.open ? " slds-is-open" : ""
    }`;
  }

  get input() {
    return this.template.querySelector("input");
  }

  @api
  focus() {
    if (this.input) {
      this.input.focus();
    }
  }

  openMenu() {
    if (this.disabled) {
      return;
    }
    if (!this.open) {
      this.open = true;
      window.addEventListener("scroll", this._place, true);
      window.addEventListener("resize", this._place);
    }
    const chosen = this.matches.findIndex(
      (option) => option.value === this._value
    );
    this.activeIndex = chosen >= 0 ? chosen : this.matches.length ? 0 : -1;
    this.first = 0;
    this.shown = PAGE;
    this.reveal();
    this._scrollActive = true;
    this.place();
  }

  closeMenu() {
    this.open = false;
    this.query = undefined;
    this.activeIndex = -1;
    this.unlisten();
  }

  unlisten() {
    window.removeEventListener("scroll", this._place, true);
    window.removeEventListener("resize", this._place);
  }

  // The menu is fixed to the viewport so a scrolling dialog can't clip it.
  place() {
    const input = this.input;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const up = below < MENU_ROOM && rect.top > below;
    const vertical = up
      ? `bottom:${window.innerHeight - rect.top + 2}px`
      : `top:${rect.bottom + 2}px`;
    this.menuStyle = `left:${rect.left}px;width:${rect.width}px;${vertical}`;
  }

  select(value) {
    this._value = value;
    this.closeMenu();
    this.dispatchEvent(new CustomEvent("change", { detail: { value } }));
  }

  handleClick(event) {
    if (!this.open) {
      this.openMenu();
      event.target.select();
    }
  }

  handleInput(event) {
    this.query = event.target.value;
    if (!this.open) {
      this.openMenu();
    }
    this.activeIndex = this.matches.length ? 0 : -1;
    this.first = 0;
    this.shown = PAGE;
    this._scrollActive = true;
  }

  handleKeyDown(event) {
    const count = this.matches.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!this.open) {
          this.openMenu();
        } else if (count) {
          const step = event.key === "ArrowDown" ? 1 : -1;
          this.activeIndex =
            this.activeIndex < 0
              ? step > 0
                ? 0
                : count - 1
              : (this.activeIndex + step + count) % count;
          this.reveal();
          this._scrollActive = true;
        }
        break;
      }
      case "Enter":
        event.preventDefault();
        if (!this.open) {
          this.openMenu();
        } else if (this.matches[this.activeIndex]) {
          this.select(this.matches[this.activeIndex].value);
        }
        break;
      case "Escape":
        if (this.open) {
          // Closes the list, not the dialog around it.
          event.preventDefault();
          event.stopPropagation();
          this.closeMenu();
        }
        break;
      case "Tab":
        this.closeMenu();
        break;
      default:
    }
  }

  handleBlur() {
    this.closeMenu();
  }

  // Keeps focus in the box so a click on an option isn't lost to blur.
  handleMenuDown(event) {
    event.preventDefault();
  }

  handleOption(event) {
    const index = Number(event.currentTarget.dataset.index);
    const option = this.matches[index];
    if (option) {
      this.select(option.value);
    }
  }

  handleHover(event) {
    this.activeIndex = Number(event.currentTarget.dataset.index);
  }

  handleMenuScroll(event) {
    const menu = event.currentTarget;
    if (
      this.shown < this.matches.length &&
      menu.scrollTop + menu.clientHeight >= menu.scrollHeight - MORE_AHEAD
    ) {
      this.showLater();
    } else if (this.first > 0 && menu.scrollTop <= MORE_AHEAD) {
      this.showEarlier();
    }
  }

  handleMore() {
    this.showLater();
  }

  handleEarlier() {
    this.showEarlier();
  }
}
