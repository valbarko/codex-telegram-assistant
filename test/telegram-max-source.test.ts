import {describe, expect, it} from 'vitest';
import {sourceVersion} from '../scripts/telegram-max/source.mts';

describe('Telegram → MAX source identity', () => {
  const message = () => ({media_album_id:'123',content:{_:'messagePhoto',
    caption:{text:'Подпись',entities:[]},photo:{sizes:[{width:100,height:100,
      photo:{id:7,size:100,local:{path:''},remote:{id:'rotating-reference',unique_id:'stable-photo'}}}]}}});
  it('ignores rotating file references, file IDs and local download state', () => {
    const first=message(), second=message();
    second.content.photo.sizes[0].photo.id=999;
    second.content.photo.sizes[0].photo.local.path='/private/local-cache';
    second.content.photo.sizes[0].photo.remote.id='new-reference';
    expect(sourceVersion(first)).toBe(sourceVersion(second));
  });
  it('detects real text edits, media replacements and album membership', () => {
    const first=message(), edited=message(), replaced=message(), regrouped=message();
    edited.content.caption.text='Правка';
    replaced.content.photo.sizes[0].photo.remote.unique_id='different-photo';
    regrouped.media_album_id='456';
    expect(sourceVersion(first)).not.toBe(sourceVersion(edited));
    expect(sourceVersion(first)).not.toBe(sourceVersion(replaced));
    expect(sourceVersion(first)).not.toBe(sourceVersion(regrouped));
  });
  it('restarts the quiet period when an edit restores the same text', () => {
    const first={...message(),edit_date:1},second={...message(),edit_date:2};
    expect(sourceVersion(first)).not.toBe(sourceVersion(second));
  });
});
