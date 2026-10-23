// VHDL blocks (56-vhdl-sim.js + 57-vhdl-block.js): a block whose inside is VHDL text, placed and
// wired like any part, simulated in the browser, emitted as written into the design's VHDL.
const { test, expect } = require("@playwright/test");
const { openEditor } = require("./helpers");

const COUNT3 = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity count3 is port ( clk, en, clr : in std_logic; q : out std_logic_vector(6 downto 0) ); end count3;
architecture rtl of count3 is
  signal cnt : unsigned(6 downto 0) := (others => '0');
begin
  process(clk) begin
    if rising_edge(clk) then
      if clr = '1' or cnt = 99 then cnt <= (others => '0'); elsif en = '1' then cnt <= cnt + 3; end if;
    end if;
  end process;
  q <= std_logic_vector(cnt);
end rtl;`;
const ROM = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity twox8 is port ( x : in std_logic_vector(3 downto 0); y : out std_logic_vector(5 downto 0); big : out std_logic ); end;
architecture b of twox8 is begin
  y <= std_logic_vector(to_unsigned(2 * to_integer(unsigned(x)) + 8, 6));
  big <= '1' when unsigned(x) > 9 else '0';
end;`;

async function wire(page, sheet, vhdl, ins, outs) {
  return page.evaluate(async ({ sheet, vhdl, ins, outs }) => {
    const r = MCP_OPS.vhdl_block({ vhdl, sheet, label: "u1" });
    for (const [n, w] of ins) MCP_OPS.add_component({ sheet, type: "IN", name: n, params: w > 1 ? { name: n, width: w } : { name: n } });
    for (const [n, w] of outs) MCP_OPS.add_component({ sheet, type: "OUT", name: n, params: w > 1 ? { name: n, width: w } : { name: n } });
    MCP_OPS.connect({ sheet, connections: [...ins.map(([n]) => [n, "u1." + n]), ...outs.map(([n]) => ["u1." + n, n])] });
    return r;
  }, { sheet, vhdl, ins, outs });
}

test("a clocked VHDL block: placed, wired, simulated clock by clock, emitted into the VHDL", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => MCP_OPS.new_sheet ? MCP_OPS.new_sheet({ name: "c3" }) : null);
  const r = await wire(page, "c3", COUNT3, [["clk", 1], ["en", 1], ["clr", 1]], [["q", 7]]);
  expect(r.name).toBe("count3");
  expect(r.sequential).toBe(true);
  expect(r.ports.map(p => p.name + p.dir + p.width)).toEqual(["clkin1", "enin1", "clrin1", "qout7"]);
  const out = await page.evaluate(() => {
    const s = MCP_OPS.simulate({ sheet: "c3", cycles: 6, vectors: [{ en: 1 }, { en: 1 }, { en: 0 }, { en: 1 }, { en: 1, clr: 1 }, { en: 1 }] });
    state.project.topId = Object.values(state.project.schematics).find(x => x.name === "c3").id;
    const v = MCP_OPS.get_vhdl({});
    const chk = MCP_OPS.check ? MCP_OPS.check({ sheet: "c3" }) : null;
    return { q: s.rows.map(x => parseInt(x.outputs.q, 2)), note: s.note || "", vhdl: v.vhdl, errs: chk && (chk.errors || []).length };
  });
  expect(out.q).toEqual([0, 3, 6, 6, 9, 0]);
  expect(out.note).not.toMatch(/บล็อก VHDL/);
  expect(out.vhdl).toContain("entity count3 is");
  expect(out.vhdl).toMatch(/: count3\s+port map/i);
});

test("a combinational VHDL block: truth table, compare against a formula, errors with the line", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => MCP_OPS.new_sheet ? MCP_OPS.new_sheet({ name: "rx" }) : null);
  await wire(page, "rx", ROM, [["x", 4]], [["y", 6], ["big", 1]]);
  const r = await page.evaluate(() => {
    const t = clientCombSim(Object.values(state.project.schematics).find(s => s.name === "rx"));
    const val = (bits, from, n) => parseInt(bits.slice(from, from + n).join(""), 2);
    const rows = t.truth_table.rows.map(([i, o]) => [val(i, 0, 4), val(o, 0, 6), o[6]]);
    const cmp = MCP_OPS.compare_sheets({ sheet: "rx", formula: "y = 2*x + 8" });
    let err = ""; try { MCP_OPS.vhdl_block({ vhdl: "entity bad is port(a : in std_logic; y : out std_logic); end;\narchitecture x of bad is begin\n  y <= a and ;\nend;" }); } catch (e) { err = e.message; }
    let multi = ""; try { MCP_OPS.vhdl_block({ vhdl: "library ieee; use ieee.std_logic_1164.all; entity m2 is port(a : in std_logic; y : out std_logic); end; architecture x of m2 is begin y <= a; y <= not a; end;" }); } catch (e) { multi = e.message; }
    return { rows, cmp: cmp.equivalent, cmpWhy: cmp.reason || "", err, multi };
  });
  expect(r.rows.every(([x, y, b]) => y === 2 * x + 8 && b === (x > 9 ? 1 : 0))).toBe(true);
  expect(r.rows.length).toBe(16);
  expect([r.cmp, r.cmpWhy]).toEqual([true, ""]);
  expect(r.err).toMatch(/บรรทัด 3/);
  expect(r.multi).toMatch(/multiple drivers/);
});

test("the dialog: write, check, save and place; double-click opens the text again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page);
  await page.evaluate(() => vhdlBlockDialog(null));
  await expect(page.locator("#vhbStatus")).toContainText("count3");
  await expect(page.locator("#vhbStatus")).toContainText("มี clock (clk)");
  await page.locator(".vhb-text").fill(ROM);
  await page.locator("#vhbCheck").click();
  await expect(page.locator("#vhbStatus")).toContainText("twox8");
  await page.locator("#vhbPlace").click();
  const placed = await page.evaluate(() => activeSch().components.filter(c => c.type === "CUSTOM:twox8").length);
  expect(placed).toBe(1);
  await page.evaluate(() => openWizard("twox8"));
  await expect(page.locator(".vhb-text")).toHaveValue(/entity twox8/);
  expect(page.errors).toEqual([]);
});

test("upper-case ports clocked from an INPUT not named clk, next to a D flip-flop on the same clock", async ({ page }) => {
  await openEditor(page);
  const r = await page.evaluate(() => {
    MCP_OPS.new_sheet({ name: "mix" });
    MCP_OPS.vhdl_block({ sheet: "mix", label: "t", vhdl: `library IEEE; use IEEE.STD_LOGIC_1164.ALL;
entity TOG is Port ( CLK : in STD_LOGIC; Q : out STD_LOGIC ); end TOG;
architecture B of TOG is signal s : std_logic := '0'; begin
  process(CLK) begin if CLK'event and CLK = '1' then s <= not s; end if; end process; Q <= s; end B;` });
    MCP_OPS.add_component({ sheet: "mix", type: "IN", name: "tick" });
    MCP_OPS.add_component({ sheet: "mix", type: "DFF", name: "ff" });
    MCP_OPS.add_component({ sheet: "mix", type: "OUT", name: "a" });
    MCP_OPS.add_component({ sheet: "mix", type: "OUT", name: "b" });
    MCP_OPS.connect({ sheet: "mix", connections: [["tick", "t.CLK"], ["tick", "ff.clk"], ["t.Q", "ff.d"], ["t.Q", "a"], ["ff.q", "b"]] });
    const s = MCP_OPS.simulate({ sheet: "mix", cycles: 6 });
    return s.rows.map(x => x.outputs).join(" ");
  });
  // the flip-flop samples Q as it was just before the same edge: b follows a one clock later
  expect(r).toBe("00 10 01 10 01 10");
});
