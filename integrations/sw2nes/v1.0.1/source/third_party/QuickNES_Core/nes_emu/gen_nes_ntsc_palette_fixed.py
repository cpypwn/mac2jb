from fractions import Fraction as F
Q=30; ONE=1<<Q
def q(x):
    x=F(x) if not isinstance(x,F) else x
    return int(round(x*ONE)) if x>=0 else -int(round(-x*ONE))
def enforce(a,b,c,target):
    qa,qb,qc=q(a),q(b),q(c); qc+=target-(qa+qb+qc); return qa,qb,qc
div255=[ (v*ONE+127)//255 for v in range(256) ]
# gray-axis enforced encode
gRY,gGY,gBY=enforce(.299,.587,.114,ONE)
gRI,gGI,gBI=enforce(.596,-.275,-.321,0)
gRQ,gGQ,gBQ=enforce(.212,-.523,.311,0)
dd=[0.956,0.621,-0.272,-0.647,-1.105,1.702]; ddF=[F(str(v)) for v in dd]
RY,GY,BY=F(299,1000),F(587,1000),F(114,1000); RI,GI,BI=F(596,1000),F(-275,1000),F(-321,1000); RQ,GQ,BQ=F(212,1000),F(-523,1000),F(311,1000)
ENC=[[RY,GY,BY],[RI,GI,BI],[RQ,GQ,BQ]]; DEC=[[F(1),ddF[0],ddF[1]],[F(1),ddF[2],ddF[3]],[F(1),ddF[4],ddF[5]]]
def mm(A,B): return [[sum(A[i][k]*B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
P=mm(DEC,mm(ENC,DEC)); Pq=[[q(P[i][j]) for j in range(3)] for i in range(3)]
phases=[-1.0,-0.866025,-0.5,0.0,0.5,0.866025,1.0,0.866025,0.5,0.0,-0.5,-0.866025,-1.0,-0.866025,-0.5,0.0,0.5,0.866025,1.0]
phq=[q(v) for v in phases]
lo=[q(v) for v in [-0.12,0.00,0.31,0.72]]; hi=[q(v) for v in [0.40,0.68,1.00,1.00]]
am=0.79399; asub=0.0782838
consts=dict(qRY=gRY,qGY=gGY,qBY=gBY,qRI=gRI,qGI=gGI,qBI=gBI,qRQ=gRQ,qGQ=gGQ,qBQ=gBQ,
 qam113=q(am*1.13),qas113=q(asub*1.13),qsm=q(0.5-am*0.5),qss=q(asub*0.5),
 qbright=q(-0.5/256),q06=q(0.6),q05=q(0.5),qoffset=q(F(1025,2)))
h=[]
h.append('/* Auto-generated Q30 fixed-point tables for nes_ntsc_palette_fixed.')
h.append('   Regenerate with:  python3 nes_emu/gen_nes_ntsc_palette_fixed.py > nes_emu/nes_ntsc_palette_fixed.h */')
h.append('#ifndef NES_NTSC_PALETTE_FIXED_H')
h.append('#define NES_NTSC_PALETTE_FIXED_H')
h.append('')
h.append('static const ntsc_i64 nes_ntsc_div255_q30[256] = {')
for r in range(0,256,8):
    h.append('  '+', '.join(str(div255[v]) for v in range(r,r+8))+',')
h.append('};')
h.append('')
h.append('/* P = DEC * ENC * DEC (post-emphasis linear map is exact: gamma is a no-op) */')
h.append('static const ntsc_i64 nes_ntsc_P_q30[3][3] = {')
for i in range(3):
    h.append('  { '+', '.join(str(Pq[i][j]) for j in range(3))+' },')
h.append('};')
h.append('')
h.append('static const ntsc_i64 nes_ntsc_phases_q30[19] = {')
h.append('  '+', '.join(str(v) for v in phq))
h.append('};')
h.append('static const ntsc_i64 nes_ntsc_hi_q30[4] = { '+', '.join(str(v) for v in hi)+' };')
h.append('static const ntsc_i64 nes_ntsc_lo_q30[4] = { '+', '.join(str(v) for v in lo)+' };')
h.append('')
for k,v in consts.items():
    h.append('#define NTSCFX_%s ((ntsc_i64)%d)'%(k,v))
h.append('')
h.append('#endif')
import sys
sys.stdout.write('\n'.join(h)+'\n')
import sys as _s; _s.stderr.write("I-row=%d Q-row=%d Y-row-2^30=%d\n"%(gRI+gGI+gBI,gRQ+gGQ+gBQ,gRY+gGY+gBY-ONE))
