#!/usr/bin/perl
use strict;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Socket qw(inet_aton inet_ntoa sockaddr_in);
use Getopt::Long qw(GetOptions);
use POSIX qw(strftime);

$|=1;
my %opt = (ip=>'192.168.2.2', peer=>'192.168.2.1', dns_port=>53, http_port=>80);
my ($serve, $probe);
GetOptions('serve'=>\$serve, 'probe'=>\$probe, 'ip=s'=>\$opt{ip},
           'peer=s'=>\$opt{peer}, 'dns-port=i'=>\$opt{dns_port},
           'http-port=i'=>\$opt{http_port}, 'log=s'=>\$opt{log}) or die "Invalid arguments\n";
die "Choose exactly one of --serve or --probe\n" unless !!$serve != !!$probe;
for my $key (qw(ip peer)) { die "Invalid $key IPv4\n" unless $opt{$key} =~ /\A(?:\d{1,3}\.){3}\d{1,3}\z/ && inet_aton($opt{$key}); }
for my $key (qw(dns_port http_port)) { die "Invalid $key\n" if $opt{$key}<1 || $opt{$key}>65535; }

my %hosts = map { $_ => 1 } qw(
  ctest.p01.ctest.srv.nintendo.net
  ctest-ipv6.p01.ctest.srv.nintendo.net
  ctest.cdn.nintendo.net
  conntest.nintendowifi.net
);
my $log_fh;
if (defined $opt{log} && $serve) {
    open($log_fh, '>>', $opt{log}) or die "Cannot append to log: $!\n";
    select((select($log_fh), $|=1)[0]);
}
sub log_line {
    my ($line) = @_;
    my $full = strftime('%Y-%m-%d %H:%M:%S ',localtime) . $line;
    print "$full\n";
    if ($log_fh) {
        if (tell($log_fh) > 4 * 1024 * 1024) {
            seek($log_fh, 0, 0) or die "Cannot rewind log: $!\n";
            truncate($log_fh, 0) or die "Cannot trim log: $!\n";
            print {$log_fh} strftime('%Y-%m-%d %H:%M:%S ',localtime) . "Log trimmed at 4 MiB\n";
        }
        print {$log_fh} "$full\n";
    }
}
sub dns_reply {
    my ($q) = @_;
    return (undef, 'malformed short query') if length($q)<12;
    my ($id, $flags, $qd) = unpack('nnn',substr($q,0,6));
    return (undef, 'unexpected DNS reply') if $flags & 0x8000;
    my $rf = 0x8400 | ($flags & 0x0100);
    return (pack('nnnnnn',$id,$rf|4,0,0,0,0), 'OPCODE BLOCK') if $flags & 0x7800;
    return (pack('nnnnnn',$id,$rf|1,0,0,0,0), 'FORMERR') if $qd != 1;
    my ($pos,$resume,$hops)=(12,undef,0);
    my @labels;
    my %seen;
    while (1) {
        return (pack('nnnnnn',$id,$rf|1,0,0,0,0),'FORMERR') if $pos>=length($q) || $seen{$pos}++ || ++$hops>128;
        my $len=ord(substr($q,$pos++,1));
        if (($len & 0xc0) == 0xc0) {
            return (pack('nnnnnn',$id,$rf|1,0,0,0,0),'FORMERR') if $pos>=length($q);
            $resume=$pos+1 unless defined($resume);
            $pos=(($len & 63)<<8) | ord(substr($q,$pos,1));
            next;
        }
        return (pack('nnnnnn',$id,$rf|1,0,0,0,0),'FORMERR') if $len>63 || $pos+$len>length($q);
        last if !$len;
        push @labels,substr($q,$pos,$len); $pos+=$len;
    }
    $pos=$resume if defined $resume;
    return (pack('nnnnnn',$id,$rf|1,0,0,0,0),'FORMERR') if $pos+4>length($q);
    my ($type,$class)=unpack('nn',substr($q,$pos,4));
    my $host=lc(join('.',@labels));
    return (pack('nnnnnn',$id,$rf|1,0,0,0,0),'FORMERR') if length($host)>253;
    my $known=$hosts{$host} && $class==1;
    my $answer=$known && $type==1;
    $rf|=3 unless $known;
    my $question=substr($q,12,$pos+4-12);
    # rebuild the question so answer pointers cannot refer outside it
    $question=join('', map { chr(length($_)).$_ } @labels) . "\0" . pack('nn',$type,$class);
    my $out=pack('nnnnnn',$id,$rf,1,$answer?1:0,0,0) . $question;
    if ($answer) {
        # answer name points to the question, with a 10 second ttl
        $out.=pack('nnnNn',0xc00c,1,1,10,4) . inet_aton($opt{ip});
    }
    return ($out, ($answer?'CTEST ':$known?'NODATA ':'BLOCK ') . "$host type=$type");
}
sub response_http {
    my ($request,$peer) = @_;
    my ($line)=split(/\r?\n/,$request,2);
    my ($method,$path,$version)=$line =~ /\A(\S+)\s+(\S+)\s+(HTTP\/1\.[01])\z/;
    my ($host)=$request =~ /^Host:\s*([^\r\n]+)\s*$/im;
    $host='' unless defined($host);
    $host =~ s/\s+$//; $host=lc($host);
    $host =~ s/:80$//;
    my $ok=($peer eq $opt{peer} || $peer eq $opt{ip})
           && defined($method) && ($method eq 'GET' || $method eq 'HEAD')
           && $path eq '/' && $hosts{$host};
    my $body=$ok?'ok':"Not found\n";
    my $status=$ok?'200 OK':'404 Not Found';
    my $header="HTTP/1.1 $status\r\nContent-Type: text/plain\r\nContent-Length: ".length($body)."\r\n";
    $header.="X-Organization: Nintendo\r\n" if $ok;
    $header.="Cache-Control: max-age=0, no-cache, no-store\r\nPragma: no-cache\r\nConnection: close\r\n\r\n";
    my $log="HTTP $peer host=$host path=".(defined($path)?$path:'?')." -> ".($ok?'200 CTEST OK':'404 BLOCK');
    return ($header.(defined($method) && $method eq 'HEAD'?'':$body),$log);
}
sub send_all {
    my ($sock,$bytes)=@_;
    my $offset=0;
    while ($offset<length($bytes)) {
        my $ready=IO::Select->new($sock)->can_write(2);
        return 0 unless $ready;
        my $n=syswrite($sock,$bytes,length($bytes)-$offset,$offset);
        return 0 unless defined $n && $n>0;
        $offset+=$n;
    }
    return 1;
}
sub do_serve {
    my $udp=IO::Socket::INET->new(LocalAddr=>$opt{ip},LocalPort=>$opt{dns_port},Proto=>'udp',ReuseAddr=>0)
        or die "Cannot bind DNS UDP $opt{ip}:$opt{dns_port}: $!\n";
    my $dns=IO::Socket::INET->new(LocalAddr=>$opt{ip},LocalPort=>$opt{dns_port},Proto=>'tcp',Listen=>16,ReuseAddr=>0)
        or die "Cannot bind DNS TCP $opt{ip}:$opt{dns_port}: $!\n";
    my $http=IO::Socket::INET->new(LocalAddr=>$opt{ip},LocalPort=>$opt{http_port},Proto=>'tcp',Listen=>16,ReuseAddr=>0)
        or die "Cannot bind HTTP $opt{ip}:$opt{http_port}: $!\n";
    my $sel=IO::Select->new($udp,$dns,$http);
    my %clients;
    my $running=1;
    $SIG{INT}=sub {$running=0}; $SIG{TERM}=sub {$running=0};
    log_line("LISTEN DNS UDP/TCP $opt{ip}:$opt{dns_port}, HTTP $opt{ip}:$opt{http_port}; allow only $opt{peer}");
    while ($running) {
        my @ready=$sel->can_read(1);
        for my $s (@ready) {
            if ($s==$udp) {
                my $buf=''; my $addr=$udp->recv($buf,4096);
                next unless defined($addr);
                my ($port,$packed)=sockaddr_in($addr); my $remote=inet_ntoa($packed);
                if ($remote ne $opt{peer} && $remote ne $opt{ip}) {log_line("DNS REJECT source=$remote:$port");next;}
                my ($answer,$msg)=dns_reply($buf);
                log_line("DNS/UDP $remote $msg");
                $udp->send($answer,0,$addr) if defined($answer);
            } elsif ($s==$dns || $s==$http) {
                my $conn=$s->accept(); next unless $conn;
                my $remote=$conn->peerhost()//'';
                if ($remote ne $opt{peer} && $remote ne $opt{ip}) {log_line("CONNECTION REJECT source=$remote");close $conn;next;}
                $conn->blocking(0);
                my $id=fileno($conn);
                $clients{$id}={sock=>$conn,buf=>'',peer=>$remote,proto=>($s==$dns?'dns':'http'),since=>time()};
                $sel->add($conn);
            } else {
                my $id=fileno($s); my $c=$clients{$id}; next unless $c;
                my $piece=''; my $n=sysread($s,$piece,8192);
                if (!defined($n)) {next if $!{EAGAIN} || $!{EWOULDBLOCK}; $n=0;}
                if (!$n) {$sel->remove($s);close $s;delete $clients{$id};next;}
                $c->{buf}.=$piece;
                my $reply;
                if ($c->{proto} eq 'dns') {
                    if (length($c->{buf})>=2) {
                        my $want=unpack('n',substr($c->{buf},0,2));
                        if ($want>=12 && $want<=4096 && length($c->{buf})>=$want+2) {
                            my ($ans,$msg)=dns_reply(substr($c->{buf},2,$want));
                            $reply=pack('n',length($ans)).$ans if defined $ans;
                            log_line("DNS/TCP $c->{peer} $msg");
                        } elsif ($want<12 || $want>4096) {$reply='';}
                    }
                } else {
                    if ($c->{buf}=~/\r?\n\r?\n/) {
                        my $msg;
                        ($reply,$msg)=response_http($c->{buf},$c->{peer});
                        log_line($msg);
                    }
                }
                if (length($c->{buf})>8192) {$reply='';}
                if (defined $reply) {
                    send_all($s,$reply) if length($reply);
                    $sel->remove($s);close $s;delete $clients{$id};
                }
            }
        }
        for my $id (keys %clients) {
            next if time()-$clients{$id}{since}<5;
            my $s=$clients{$id}{sock};$sel->remove($s);close $s;delete $clients{$id};
        }
    }
    for my $id (keys %clients) {close $clients{$id}{sock};}
    close $udp;close $dns;close $http;
    log_line('Responder stopped.');
}
sub make_query {
    my ($host,$type)=@_;
    my $domain=join('',map {chr(length($_)).$_} split(/\./,$host))."\0";
    return pack('nnnnnn',0x1234,0x0100,1,0,0,0).$domain.pack('nn',$type,1);
}
sub do_probe {
    for my $host (sort keys %hosts) {
        my $udp=IO::Socket::INET->new(Proto=>'udp',LocalAddr=>$opt{ip},LocalPort=>0,
            PeerAddr=>$opt{ip},PeerPort=>$opt{dns_port},Timeout=>2)
            or die "DNS probe socket failed: $!\n";
        my $q=make_query($host,1);
        $udp->send($q) or die "DNS probe send failed: $!\n";
        my $readers=IO::Select->new($udp);
        die "DNS probe timeout for $host\n" unless scalar($readers->can_read(2));
        my $buf=''; $udp->recv($buf,4096);close $udp;
        die "Wrong DNS A response for $host\n" unless length($buf)>=16 && unpack('n',substr($buf,6,2))==1 && substr($buf,-4) eq inet_aton($opt{ip});
        my $tcp=IO::Socket::INET->new(Proto=>'tcp',LocalAddr=>$opt{ip},
           PeerAddr=>$opt{ip},PeerPort=>$opt{http_port},Timeout=>2)
           or die "HTTP probe connect failed: $!\n";
        my $request="GET / HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n";
        send_all($tcp,$request) or die "HTTP probe write failed\n";
        my $data=''; my $readers_http=IO::Select->new($tcp);
        while (scalar($readers_http->can_read(2))) {
            my $chunk='';my $got=sysread($tcp,$chunk,8192);
            last unless defined $got && $got>0;
            $data.=$chunk;
            last if length($data)>16384;
        }
        close $tcp;
        die "HTTP probe failed for $host\n" unless
          $data =~ /^HTTP\/1\.1 200 OK\r\n/ &&
          $data =~ /^X-Organization: Nintendo\r?$/im &&
          $data =~ /\r\n\r\nok\z/;
    }
    print "SELF-CHECK PASSED: all four DNS / HTTP Nintendo probe hostnames\n";
}
$serve ? do_serve() : do_probe();
