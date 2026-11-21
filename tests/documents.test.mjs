// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const actor=testPrincipal('conversion','u','admin')
const other=testPrincipal('conversion','visitor')
let worker
before(async()=>{worker=await localWorker({principals:[actor,other],embeddings:'fixture',vars:{OPENVIKING_EDGE_DOCUMENT_CONVERSION:'1'}});await worker.ready})
after(async()=>await worker?.dispose())

function pdf(text) {
  // Tiny inert PDF with correct xref offsets and a real page, no remote references/actions.
  let data='%PDF-1.4\n'
  const stream=`BT /F1 12 Tf 36 90 Td (${text}) Tj ET`
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const offsets=objects.map((body,i)=>{const start=data.length;data+=`${i+1} 0 obj\n${body}\nendobj\n`;return start})
  const start=data.length
  return data+`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(x=>`${String(x).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
}

function multipart(data,mime='application/pdf') {
  const form=new FormData()
  form.set('file',new Blob([data],{type:mime}),'schedule.pdf')
  return form
}
const send=(identity,name,method='GET',body)=>api(worker,identity)('/api/v1/'+name,{method,body})

test('opt-in conversion stages only Markdown in the same durable upload flow',async()=>{
  const r=await send(actor,'resources/temp_upload','POST',multipart(pdf('Original test content')))
  const data=await r.json()
  assert.equal(r.status,200,data.error?.message)
  assert.equal(data.result.filename,'schedule.md')
  const input={temp_file_id:data.result.temp_file_id,to:'viking://resources/schedule.md',wait:true}
  assert.equal((await send(other,'resources','POST',input)).status,404)
  const saved=await send(actor,'resources','POST',input)
  assert.equal(saved.status,200,(await saved.json()).error?.message)
  const text=await send(actor,'content/read?uri='+encodeURIComponent(input.to))
  assert.equal(text.status,200)
  assert.match((await text.json()).result,/Fixture-only Markdown/)
  const missing=await send(actor,'fs/stat?uri='+encodeURIComponent('viking://resources/schedule.pdf'))
  assert.equal(missing.status,404)
  assert.equal((await send(actor,'resources','POST',input)).status,404)
})

test('malformed format is rejected and no upload token is issued',async()=>{
  for (const data of [multipart('plain text wearing the wrong extension'),multipart(pdf('Test note'),'image/png')]) {
    const r=await send(actor,'resources/temp_upload','POST',data)
    assert.equal(r.status,415)
    assert.equal((await r.json()).result,undefined)
  }
})
