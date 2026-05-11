CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  total_cents INT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO orders (customer_name, total_cents, status) VALUES
  ('Alice', 4999, 'shipped'),
  ('Bob', 1250, 'pending'),
  ('Charlie', 8900, 'delivered');
