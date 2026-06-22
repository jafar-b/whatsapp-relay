"""
sync_contacts.py — Import Google Contacts VCF into store.json

Usage:
    1. Export contacts from contacts.google.com as vCard (.vcf)
    2. Save the file to this folder as contacts.vcf
    3. Run: python3 sync_contacts.py
    4. Restart the bridge: pm2 restart wa-relay
"""

import re
import json
import os

VCF_FILE = os.path.join(os.path.dirname(__file__), 'contacts.vcf')
STORE_FILE = os.path.join(os.path.dirname(__file__), 'store.json')


def parse_vcf(filepath):
    contacts = {}
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
    cards = content.split('BEGIN:VCARD')
    for card in cards:
        if not card.strip():
            continue
        name_match = re.search(r'\nFN:(.*)', card)
        if not name_match:
            continue
        name = name_match.group(1).strip()
        phones = re.findall(r'TEL[^:]*:([\d\s\+\-\(\)]+)', card)
        for phone in phones:
            digits = re.sub(r'\D', '', phone)
            if len(digits) < 7:
                continue
            contacts[digits] = name
            if len(digits) >= 10:
                contacts[digits[-10:]] = name
    return contacts


def main():
    if not os.path.exists(VCF_FILE):
        print(f"Error: {VCF_FILE} not found. Export your contacts from contacts.google.com first.")
        return

    if not os.path.exists(STORE_FILE):
        print(f"Error: {STORE_FILE} not found. Start the bridge first to generate it.")
        return

    vcf = parse_vcf(VCF_FILE)
    print(f"Parsed {len(vcf)} phone numbers from VCF")

    store = json.load(open(STORE_FILE))
    chats = store['chats']
    contacts = store.setdefault('contacts', {})

    updated = 0
    for jid, chat in chats.items():
        if chat.get('type') != 'personal':
            continue
        phone = jid.split('@')[0]
        if chat.get('name') != phone:
            continue  # already has a real name
        name = vcf.get(phone) or (vcf.get(phone[-10:]) if len(phone) >= 10 else None)
        if name:
            chat['name'] = name
            if jid in contacts:
                contacts[jid]['name'] = name
            else:
                contacts[jid] = {'id': jid, 'name': name}
            updated += 1

    with open(STORE_FILE, 'w') as f:
        json.dump(store, f)

    print(f"Updated {updated} contact names")
    print("Done — run: pm2 restart wa-relay")


if __name__ == '__main__':
    main()
