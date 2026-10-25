/* ===== 62. The sim page on big designs (lab 9: an 8-bit ALU on switches, a ÷50 000 scan for the display) =====
   - A sheet with a clock divider gets the divider panel instead of the clock controls — and the
     "⚡ เล่นเวลาจริง" button lived in those controls, so the one mode that runs such a design (the display
     scans at 1 kHz, 50 000 clocks per step) was gone. The panel now carries it too.
   - Clock by clock, a bus INPUT could only be 0 or 1 (one switch per input). Its bits now sit on the
     switches its pin map gives (in_a[0] → SW0 …, else free switches in a row); flipping one changes that
     bit from the clock on show onward, like any switch there. */

/* ---- ⚡ on the divider panel ---- */
{
  const _bind=bindDividerPanel;
  bindDividerPanel=function(div){
    const r=_bind.apply(this, arguments);
    try{
      const S=SIM_SEQ, sch=(S && S.run) || activeSch(), msg=$("#simBoardMsg");
      if(sch && msg && rtAvailable(sch) && !msg.querySelector('[data-act="rt-toggle"]')){
        msg.insertAdjacentHTML("afterbegin", `<div class="seq-ctrl sb-rt"><span class="rt-ctl"><button class="btn2 rt-go" data-act="rt-toggle">⚡ เล่นเวลาจริง (50 MHz)</button>
          <label class="muted">ช้ากว่าจริง <select id="rtSpeed"><option value="1">เร็วสุดเท่าที่ทำได้</option><option value="0.1">1/10</option><option value="0.01">1/100</option><option value="0.001" selected>1/1,000</option><option value="0.0001">1/10,000</option></select></label></span>
          <span class="muted">— วงจรนี้มีตัวหารความถี่: จอ 7-seg / ไฟกระพริบจะเห็นจริงในโหมดนี้ · สวิตช์ทุกบิตและปุ่มกดใช้ได้ระหว่างเล่น</span></div>`);
        const sp=document.getElementById("rtSpeed"); RT.speed=+sp.value; sp.onchange=()=>{ RT.speed=+sp.value; };
      }
    }catch(e){ console.warn("rt on divider panel", e); }
    return r;
  };
}

/* ---- bus inputs bit by bit on the clock-by-clock board ---- */
function sbBusBits(S){
  const sch=S.sch || S.run; if(!sch || !S.ids) return [];
  const own=sch.pinmap||{}, pm=k=>(typeof pmGet==="function"?pmGet(own,k):own[k])||"";
  const used=new Set(S.swOf.filter(x=>x!=null)), out=[];
  S.inputs.forEach((name,k)=>{
    const c=sch.components.find(x=>x.id===S.ids[k]); const w=c ? Math.max(1,(c.params&&c.params.width)||1) : 1;
    if(w<2) return;
    if(S.swOf[k]!=null) used.delete(S.swOf[k]);           // the one switch it was given: not a bit of it
    const bits=[];
    for(let i=0;i<w && i<16;i++){ const t=pm(`${name}[${i}]`); if(/^sw:\d+$/.test(t)){ bits.push({bit:i, sw:+t.slice(3)}); used.add(+t.slice(3)); } }
    out.push({k, name, w, bits});
  });
  // a bus with no pins of its own: consecutive free switches, bit 0 on the lowest
  out.filter(b=>!b.bits.length).forEach(b=>{ for(let i=0;i<b.w;i++){ let s=0; while(used.has(s)) s++; if(s>15) break; used.add(s); b.bits.push({bit:i, sw:s}); } });
  return out;
}
{
  const _wire=wireSimBoardSeq;
  wireSimBoardSeq=function(j, opts){
    const r=_wire.apply(this, arguments);
    try{
      const S=SIM_SEQ; if(!S || !S.hist) return r;
      S.busBits=sbBusBits(S);
      S.busBits.forEach(b=>{ S.swOf[b.k]=null;
        b.bits.forEach(x=>{ const u=document.querySelector('#simPcb .swUnit[data-sw="'+x.sw+'"]');
          if(u){ u.classList.add("mapped"); const nm=u.querySelector(".swName"); if(nm) nm.textContent=`${b.name}[${x.bit}]`; } }); });
      if(S.busBits.length){
        try{ seqShow(S.idx); }catch(_){}
        const sig=$("#simSignals");
        if(sig) sig.querySelectorAll("span").forEach(sp=>{ if(/ป้อนได้แค่ 0\/1/.test(sp.textContent)) sp.innerHTML=
          "บัส "+S.busBits.map(b=>esc(b.name)).join(", ")+" อยู่บนสวิตช์ทีละบิตแล้ว (ตามหน้าเลือกขา) · วงจรที่มีตัวหารความถี่ ใช้ ⚡ เล่นเวลาจริง เพื่อดูจอ / ไฟกระพริบ"; });
      }
    }catch(e){ console.warn("bus switches", e); }
    return r;
  };
  const _toggle=seqToggle;
  seqToggle=function(sw){
    const S=SIM_SEQ;
    const b=S && S.hist && (S.busBits||[]).find(x=>x.bits.some(y=>y.sw===sw));
    if(!b) return _toggle.apply(this, arguments);
    const bit=b.bits.find(y=>y.sw===sw).bit, cur=+S.hist[S.idx][b.k]||0, on=(cur>>>bit)&1;
    for(let i=S.idx;i<S.hist.length;i++){ const v=+S.hist[i][b.k]||0; S.hist[i][b.k]=on ? (v & ~(1<<bit)) : (v | (1<<bit)); }
    if(seqResim(S.hist.length)) seqShow(S.idx);
  };
  const _show=seqShow;
  seqShow=function(i){
    const r=_show.apply(this, arguments);
    const S=SIM_SEQ; if(!S || !S.busBits || !S.busBits.length) return r;
    const row=S.rows[S.idx]; if(!row) return r;
    S.busBits.forEach(b=>{ const v=+row[1][b.k]||0;
      b.bits.forEach(x=>{ const u=document.querySelector('#simPcb .swUnit[data-sw="'+x.sw+'"]'), th=u&&u.querySelector(".swThumb"); if(!th) return;
        const on=(v>>>x.bit)&1; th.style.top=on?"1px":"12px"; th.style.background=on?"#222":"#aaa"; }); });
    return r;
  };
}
