package main

import (
	"net"
	"net/url"
)

// PostgresURL is a postgres:// URL with its credentials escaped. Before, a
// password with "@", "/" or ":" broke the hand-built URL, so the database
// never became ready and dbQuery failed.
func PostgresURL(user, password, host, port, db string) string {
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(user, password),
		Host:     net.JoinHostPort(host, port),
		Path:     "/" + db,
		RawQuery: "sslmode=disable",
	}
	if password == "" {
		u.User = url.User(user)
	}
	return u.String()
}

// MongoURL is a mongodb:// URL with its credentials escaped; without them,
// one for a database with no authentication.
func MongoURL(user, password, host, port, db string) string {
	u := url.URL{Scheme: "mongodb", Host: net.JoinHostPort(host, port), Path: "/" + db}
	if user != "" && password != "" {
		u.User = url.UserPassword(user, password)
		u.RawQuery = "authSource=admin"
	}
	return u.String()
}
