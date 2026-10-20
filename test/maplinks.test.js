import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findMapLinks, parseMapsUrl, pinLinkedPlaces } from '../src/enrich/maplinks.js'
import { userTurn } from '../src/prompt.js'

test('finds Google Maps links inside Thai text without grabbing the words after them', () => {
  const text = 'เริ่มที่พัก https://maps.app.goo.gl/NKhJHHstegahjE2r6 จากนั้นไปแมคโคร https://maps.app.goo.gl/c469GvED13LU84nM7) แล้วก็ https://www.google.com/maps/place/X/@1,2 และ https://example.com/x'
  assert.deepEqual(findMapLinks(text), [
    'https://maps.app.goo.gl/NKhJHHstegahjE2r6',
    'https://maps.app.goo.gl/c469GvED13LU84nM7',
    'https://www.google.com/maps/place/X/@1,2',
  ])
})

test('reads the place name and pin (not the map centre) from a full maps URL', () => {
  const url = 'https://www.google.com/maps/place/EL+MAR+HUAHIN+Pool+Villa/@12.6561089,99.8704515,11510m/data=!3m1!1e3!4m9!3m8!1s0x30fd:0xfc!8m2!3d12.634303!4d99.9252002!16s'
  assert.deepEqual(parseMapsUrl(url), { name: 'EL MAR HUAHIN Pool Villa', lat: 12.634303, lng: 99.9252002 })
  assert.deepEqual(parseMapsUrl('https://www.google.com/maps/place/%E0%B8%95%E0%B8%A5%E0%B8%B2%E0%B8%94/@12.5,99.9,17z'), { name: 'ตลาด', lat: 12.5, lng: 99.9 })
  assert.deepEqual(parseMapsUrl('https://maps.google.com/maps?q=12.57,99.95'), { name: '', lat: 12.57, lng: 99.95 })
})

test('linked places override model coordinates and attach to a stop the model named', () => {
  const linked = [
    { url: 'https://maps.app.goo.gl/AAA', name: 'Makro Food Service', lat: 12.6205083, lng: 99.9490753 },
    { url: 'https://maps.app.goo.gl/BBB', name: 'Hua Hin Night Market', lat: 12.5711198, lng: 99.955467 },
  ]
  const plan = { days: [{ items: [
    { name: 'Makro', mapsUrl: 'https://maps.app.goo.gl/AAA', lat: 12.7, lng: 100 },
    { name: 'Hua Hin Night Market (ตลาดโต้รุ่ง)', mapsUrl: '', lat: 0, lng: 0 },
    { name: 'Some café', mapsUrl: '', lat: 12.1, lng: 99.1 },
  ] }] }
  const [a, b, c] = pinLinkedPlaces(plan, linked).days[0].items
  assert.deepEqual([a.lat, a.lng, a.pinned], [12.6205083, 99.9490753, true])
  assert.deepEqual([b.mapsUrl, b.lat, b.pinned], ['https://maps.app.goo.gl/BBB', 12.5711198, true])
  assert.deepEqual([c.mapsUrl, c.pinned], ['', undefined])
})

test('the planner prompt lists the linked places', () => {
  const turn = userTurn({ description: 'trip', today: '2026-10-20', currency: 'THB', linked: [{ url: 'https://maps.app.goo.gl/AAA', name: 'Makro', lat: 1, lng: 2 }] })
  assert.match(turn, /Linked places/)
  assert.match(turn, /https:\/\/maps\.app\.goo\.gl\/AAA → Makro \(1, 2\)/)
})
