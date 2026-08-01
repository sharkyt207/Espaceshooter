import { defineItem, type ItemDef } from './ItemTypes';

/**
 * MiscData - valuables, crafting materials, tools, keys and quest items.
 *
 * These are the items that make looting a *decision* rather than a reflex.
 * A gold chain is pure profit and weighs nothing. A welding set is heavy and
 * worth little at a trader - but it is the only way to upgrade the workshop.
 * Knowing which is which is the knowledge curve of the genre, so descriptions
 * name the use case explicitly instead of hiding it in a wiki.
 */

interface MiscSpec {
  id: string;
  name: string;
  short: string;
  category: ItemDef['category'];
  rarity: ItemDef['rarity'];
  w: number;
  h: number;
  weight: number;
  price: number;
  stack?: number;
  color: string;
  tags: string[];
  desc: string;
  keyOpens?: string[];
  keyUses?: number;
}

const SPECS: MiscSpec[] = [
  // --- valuables -----------------------------------------------------------
  { id: 'val_chain', name: 'Goldkette', short: 'Goldkette', category: 'valuable', rarity: 'rare', w: 1, h: 1, weight: 0.06, price: 68000, color: '#c8a83a', tags: ['valuable', 'gold'], desc: 'Massive Goldkette. Leicht, wertvoll, perfekt für den Sicherheitsbehälter.' },
  { id: 'val_watch', name: 'Chronograph', short: 'Uhr', category: 'valuable', rarity: 'epic', w: 1, h: 1, weight: 0.09, price: 142000, color: '#d8c05a', tags: ['valuable'], desc: 'Mechanische Präzisionsuhr. Ein einzelnes Feld, ein ganzer Einsatz bezahlt.' },
  { id: 'val_cash', name: 'Geldbündel', short: 'Bargeld', category: 'valuable', rarity: 'uncommon', w: 1, h: 1, weight: 0.11, price: 24000, stack: 10, color: '#6a9a5a', tags: ['valuable', 'cash'], desc: 'Gebündelte Scheine. Stapelbar - nimm alles mit, was du findest.' },
  { id: 'val_icon', name: 'Silberikone', short: 'Ikone', category: 'valuable', rarity: 'epic', w: 2, h: 2, weight: 0.7, price: 186000, color: '#a8b0c0', tags: ['valuable', 'art'], desc: 'Getriebene Silberarbeit aus einer geplünderten Kapelle. Sperrig, aber sehr begehrt.' },
  { id: 'val_datacore', name: 'Datenkern', short: 'Datenk.', category: 'valuable', rarity: 'legendary', w: 1, h: 1, weight: 0.15, price: 320000, color: '#5ac8d8', tags: ['valuable', 'tech', 'quest'], desc: 'Versiegelter Militärspeicher. Der wertvollste Gegenstand, der in eine Hand passt.' },
  { id: 'val_bullion', name: 'Silberbarren', short: 'Barren', category: 'valuable', rarity: 'rare', w: 1, h: 1, weight: 1.05, price: 88000, color: '#b8bcc4', tags: ['valuable'], desc: 'Gegossener Barren. Hoher Wert, spürbares Gewicht.' },

  // --- crafting materials --------------------------------------------------
  { id: 'mat_scrap', name: 'Metallschrott', short: 'Schrott', category: 'material', rarity: 'common', w: 1, h: 1, weight: 0.6, price: 2400, stack: 20, color: '#7a7a70', tags: ['material', 'metal'], desc: 'Verwertbarer Metallschrott. Grundstoff für fast jede Werkstattarbeit.' },
  { id: 'mat_wire', name: 'Kabelbündel', short: 'Kabel', category: 'material', rarity: 'common', w: 1, h: 1, weight: 0.35, price: 3200, stack: 20, color: '#8a6a3a', tags: ['material', 'electric'], desc: 'Kupferkabel in verschiedenen Stärken. Wird für Strom- und Elektronikausbauten gebraucht.' },
  { id: 'mat_circuit', name: 'Schaltplatine', short: 'Platine', category: 'material', rarity: 'uncommon', w: 1, h: 1, weight: 0.12, price: 12800, stack: 10, color: '#3a8a5a', tags: ['material', 'electric'], desc: 'Intakte Steuerplatine. Voraussetzung für alle höheren Werkstattstufen.' },
  { id: 'mat_chem', name: 'Chemikalienbehälter', short: 'Chemie', category: 'material', rarity: 'uncommon', w: 1, h: 2, weight: 0.9, price: 16400, stack: 6, color: '#8a8a3a', tags: ['material', 'chem'], desc: 'Industriechemikalien. Grundstoff für Medikamentenherstellung.' },
  { id: 'mat_powder', name: 'Treibladungspulver', short: 'Pulver', category: 'material', rarity: 'uncommon', w: 1, h: 1, weight: 0.45, price: 14000, stack: 12, color: '#4a4a48', tags: ['material', 'ammo'], desc: 'Nitrocellulosepulver. Ohne das hier stellst du keine Munition her.' },
  { id: 'mat_cloth', name: 'Verbandstoff', short: 'Stoff', category: 'material', rarity: 'common', w: 1, h: 1, weight: 0.2, price: 1900, stack: 20, color: '#c8c0b0', tags: ['material', 'med'], desc: 'Steriler Stoff auf Rolle. Basis für Verbände und Schienen.' },
  { id: 'mat_fuel', name: 'Treibstoffkanister', short: 'Sprit', category: 'material', rarity: 'uncommon', w: 2, h: 2, weight: 8.2, price: 34000, color: '#a85a3a', tags: ['material', 'fuel'], desc: 'Zwanzig Liter Diesel. Hält den Generator im Versteck am Laufen - und wiegt entsprechend.' },
  { id: 'mat_battery', name: 'Industriebatterie', short: 'Batterie', category: 'material', rarity: 'rare', w: 2, h: 1, weight: 3.6, price: 46000, color: '#3a6a8a', tags: ['material', 'electric'], desc: 'Schwere Akkuzelle. Notwendig für den Ausbau der Stromversorgung.' },
  { id: 'mat_steel', name: 'Werkzeugstahl', short: 'Stahl', category: 'material', rarity: 'rare', w: 1, h: 2, weight: 2.8, price: 38000, stack: 5, color: '#8a9098', tags: ['material', 'metal'], desc: 'Gehärteter Stahl in Stangenform. Für Waffenreparaturen und Panzerungsfertigung.' },

  // --- tools ---------------------------------------------------------------
  { id: 'tool_multi', name: 'Multiwerkzeug', short: 'Multitool', category: 'tool', rarity: 'uncommon', w: 1, h: 1, weight: 0.28, price: 18500, color: '#6a7a8a', tags: ['tool'], desc: 'Klapp-Multiwerkzeug. Wird für Werkstatt- und Waffenmodifikationen benötigt.' },
  { id: 'tool_welder', name: 'Schweißgerät', short: 'Schweiß', category: 'tool', rarity: 'rare', w: 2, h: 2, weight: 6.4, price: 64000, color: '#a8683a', tags: ['tool'], desc: 'Tragbares Schweißgerät. Schlüsselwerkzeug für den Ausbau der Werkstatt.' },
  { id: 'tool_solder', name: 'Lötstation', short: 'Löten', category: 'tool', rarity: 'rare', w: 2, h: 1, weight: 1.8, price: 42000, color: '#8a8a5a', tags: ['tool'], desc: 'Feinlötstation für Elektronikarbeiten.' },
  { id: 'tool_kit_gun', name: 'Waffenpflegeset', short: 'Pflegeset', category: 'tool', rarity: 'uncommon', w: 2, h: 1, weight: 0.9, price: 24000, color: '#5a6a5a', tags: ['tool', 'repair'], desc: 'Reinigt und wartet Waffen. Stellt Waffenzustand im Versteck wieder her.' },
  { id: 'tool_kit_armor', name: 'Panzerungsreparaturset', short: 'Panzerrep.', category: 'tool', rarity: 'rare', w: 2, h: 1, weight: 1.6, price: 46000, color: '#5a5a6a', tags: ['tool', 'repair'], desc: 'Ersatzplatten und Harz. Repariert beschädigte Schutzausrüstung.' },

  // --- keys ----------------------------------------------------------------
  { id: 'key_dock_gate', name: 'Hafenschlüssel', short: 'Hafenschl.', category: 'key', rarity: 'rare', w: 1, h: 1, weight: 0.02, price: 52000, color: '#c8a03a', tags: ['key'], desc: 'Öffnet das Kanalsteg-Tor. Ein zweiter Fluchtweg ist manchmal alles.', keyOpens: ['ex_2'], keyUses: -1 },
  { id: 'key_office', name: 'Verwaltungsschlüssel', short: 'Büroschl.', category: 'key', rarity: 'uncommon', w: 1, h: 1, weight: 0.02, price: 28000, color: '#a89a5a', tags: ['key'], desc: 'Schließt das verriegelte Büro im Verwaltungstrakt auf. Drei Nutzungen.', keyOpens: ['door_office'], keyUses: 3 },
  { id: 'key_depot', name: 'Depotschlüssel', short: 'Depotschl.', category: 'key', rarity: 'epic', w: 1, h: 1, weight: 0.02, price: 96000, color: '#c85a3a', tags: ['key'], desc: 'Zugang zum gesicherten Waffendepot. Der lohnendste Raum der Karte.', keyOpens: ['door_depot'], keyUses: 5 },

  // --- quest items ---------------------------------------------------------
  { id: 'q_dossier', name: 'Versiegelte Akte', short: 'Akte', category: 'quest', rarity: 'rare', w: 1, h: 2, weight: 0.3, price: 0, color: '#a8a090', tags: ['quest'], desc: 'Versiegelte Personalakte. Auftragsgegenstand - beim Händler abzugeben.' },
  { id: 'q_sample', name: 'Laborprobe', short: 'Probe', category: 'quest', rarity: 'rare', w: 1, h: 1, weight: 0.15, price: 0, color: '#5ac88a', tags: ['quest'], desc: 'Gekühlte Gewebeprobe. Auftragsgegenstand - reagiert empfindlich auf lange Einsätze.' },
  { id: 'q_transmitter', name: 'Peilsender', short: 'Peilsend.', category: 'quest', rarity: 'rare', w: 1, h: 1, weight: 0.2, price: 0, color: '#c85a8a', tags: ['quest'], desc: 'Aktiver Peilsender. Muss an einem bestimmten Ort platziert werden.' },
];

export const MISC_ITEMS: ItemDef[] = SPECS.map((s) =>
  defineItem({
    id: s.id,
    name: s.name,
    shortName: s.short,
    category: s.category,
    rarity: s.rarity,
    width: s.w,
    height: s.h,
    weight: s.weight,
    basePrice: s.price,
    stackable: (s.stack ?? 1) > 1,
    maxStack: s.stack ?? 1,
    description: s.desc,
    color: s.color,
    tags: s.tags,
    key: s.keyOpens ? { uses: s.keyUses ?? 1, opens: s.keyOpens } : undefined,
  }),
);
