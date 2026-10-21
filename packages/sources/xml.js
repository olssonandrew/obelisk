import { XMLParser, XMLValidator } from 'fast-xml-parser';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true });
export const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
export const text = value => Array.isArray(value) ? value.map(text).find(Boolean) || '' : typeof value === 'object' && value !== null ? String(value['#text'] || '') : String(value ?? '');
export const plain = value => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
export function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feeds with document types or custom entities are not supported.');
  if (XMLValidator.validate(xml) !== true) throw new Error('The source did not return valid XML.');
  return parser.parse(xml);
}
