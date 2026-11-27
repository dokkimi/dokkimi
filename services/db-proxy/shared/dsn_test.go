package shared

import (
	"net/url"
	"testing"
)

// A password with URL characters survives: before, it broke the URL
func TestURLsEscapeCredentials(t *testing.T) {
	const password = "p@ss/w:rd?x#1"
	for name, raw := range map[string]string{
		"postgres": PostgresURL("app", password, "db", "5432", "shop"),
		"mongo":    MongoURL("app", password, "db", "27017", "shop"),
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got, _ := u.User.Password()
		if u.User.Username() != "app" || got != password || u.Host != "db:"+u.Port() || u.Path != "/shop" {
			t.Errorf("%s: %s reads back as user %q password %q path %q", name, raw, u.User.Username(), got, u.Path)
		}
	}
}

func TestURLsWithoutPassword(t *testing.T) {
	if got := PostgresURL("postgres", "", "db", "5432", "postgres"); got != "postgres://postgres@db:5432/postgres?sslmode=disable" {
		t.Errorf("postgres: %s", got)
	}
	if got := MongoURL("", "", "db", "27017", "shop"); got != "mongodb://db:27017/shop" {
		t.Errorf("mongo: %s", got)
	}
}
