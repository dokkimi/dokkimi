db = db.getSiblingDB('dokkimi');

const lorem =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
const cats = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

const batch = [];
for (let i = 1; i <= 20000; i++) {
  batch.push({
    recordKey: 'REC-' + String(i).padStart(5, '0'),
    title: 'Record number ' + i + ' — ' + cats[i % 5],
    description: lorem + lorem,
    category: cats[i % 5],
    metadata: {
      index: i,
      priority: i % 10 === 0 ? 'high' : i % 3 === 0 ? 'medium' : 'low',
      score: Math.round(Math.random() * 10000) / 100,
      dimensions: {
        width: i % 200,
        height: (i * 7) % 300,
        depth: (i * 13) % 100,
      },
      history: [
        { event: 'created', ts: new Date(Date.now() - i * 3600000) },
        { event: 'updated', ts: new Date(Date.now() - (i / 2) * 3600000) },
      ],
    },
    tags: [cats[i % 5], cats[(i + 1) % 5], 'batch-' + Math.floor(i / 100)],
    createdAt: new Date(),
  });

  if (batch.length === 500) {
    db.large_records.insertMany(batch);
    batch.length = 0;
  }
}
if (batch.length > 0) {
  db.large_records.insertMany(batch);
}
