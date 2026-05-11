db = db.getSiblingDB('dokkimi');

db.orders.insertMany([
  {
    orderId: 'ORD-001',
    customer: 'alice@example.com',
    items: [{ sku: 'Widget', qty: 2, price: 9.99 }],
    total: 19.98,
    status: 'completed',
  },
  {
    orderId: 'ORD-002',
    customer: 'bob@example.com',
    items: [{ sku: 'Gadget', qty: 1, price: 24.99 }],
    total: 24.99,
    status: 'pending',
  },
]);
