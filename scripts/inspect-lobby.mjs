import { connect } from './cdp.mjs';
const tabs = await fetch('http://127.0.0.1:9239/json/list').then((r) => r.json());
for (const t of tabs.filter((t) => t.type === 'page')) {
  const c = await connect(t);
  console.log(
    await c.evalJS(
      '({url:location.href,body:document.body.innerText,canvases:document.querySelectorAll("canvas").length,buttons:[...document.querySelectorAll("button")].map(x=>({text:x.innerText,title:x.title,label:x.getAttribute("aria-label"),disabled:x.disabled})),select:[...document.querySelectorAll("select")].map(x=>({value:x.value,options:[...x.options].map(x=>[x.value,x.textContent])}))})',
    ),
  );
  c.close();
}
