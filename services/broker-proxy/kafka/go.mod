module github.com/dokkimi/dokkimi/services/broker-proxy/kafka

go 1.25

require (
	github.com/dokkimi/dokkimi/services/broker-proxy/shared v0.0.0
	github.com/klauspost/compress v1.18.2
	github.com/pierrec/lz4/v4 v4.1.22
	github.com/twmb/franz-go/pkg/kmsg v1.12.0
)

replace github.com/dokkimi/dokkimi/services/broker-proxy/shared => ../shared
