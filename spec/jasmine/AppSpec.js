describe("App", function() {

  beforeEach(function() {
    //
  });

  it("should not fail", function(done) {
    var ThinxApp = require('../../index.js');
    expect(ThinxApp).toBeDefined();
  }, 20000);  

});
