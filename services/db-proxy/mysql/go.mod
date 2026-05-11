module dokkimi.com/db-proxy-mysql

go 1.25

require (
	dokkimi.com/db-proxy-shared v0.0.0
	github.com/go-sql-driver/mysql v1.10.0
)

require filippo.io/edwards25519 v1.2.0 // indirect

replace dokkimi.com/db-proxy-shared => ../shared
